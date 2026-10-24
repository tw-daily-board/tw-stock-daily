"""營收 × 估值 × 股價落後：找營收轉強、估值偏低、股價還沒反應或法人沒在買的個股。

全部用固定規則計算，不用 LLM：
  - 月營收   證交所 openapi t187ap05_L（上市）、櫃買 openapi mopsfin_t187ap05_O（上櫃），每月存一份到
             data/revenue/YYYYMM.json，保留 13 個月（之後才能算連續 3 個月年增、近 12 個月新高）
  - 估值     證交所 BWIBBU_d（上市本益比、殖利率、股價淨值比）、櫃買 peQryDate（上櫃）
  - 股價     data/quotes/ 的 61 個交易日行情，以還原股價（排除除權息與分割）計算；加權指數取自 FMTQIK
  - 法人     data/inst/ 近 10 日外資＋投信
輸出 data/value.json（營收估值分頁讀這個檔）。
"""
import json
import statistics
import time
from pathlib import Path

from fetch_screens import adj_closes

ROOT = Path(__file__).resolve().parent.parent
REV_DIR = ROOT / "data" / "revenue"
OUT = ROOT / "data" / "value.json"
KEEP_MONTHS = 13
PRICE_DAYS = 61           # 今天＋前 60 個交易日

# 篩選門檻（網頁可個別開關條件，門檻本身改這裡）
MIN_AVG_VOL = 300         # 排除：近 20 日均量不到幾張
MIN_REV_LY = 100000       # 排除：去年同月營收不到幾仟元（1 億）
REV_YOY = 20              # 營收：當月年增率 > 20%
REV_CUM_YOY = 10          # 營收：累計年增率 > 10%
PER_MAX = 15              # 估值：本益比 < 15 倍，或低於同產業中位數
INST_DAYS = 10            # 法人：近 10 日外資＋投信


def fnum(s):
    try:
        v = float(str(s).replace(",", "").strip())
        return v
    except ValueError:
        return None


# ---------- 月營收 ----------
def parse_revenue(rows, market, min_count):
    """openapi 的營收彙總表 -> (西元年月 YYYYMM, {代號: {...}})；欄位或數字對不上就報錯"""
    months = {r.get("資料年月") for r in rows}
    if len(months) != 1:
        raise RuntimeError(f"{market}營收資料年月不唯一：{sorted(months)}")
    roc = months.pop()
    ym = f"{int(roc[:-2]) + 1911}{roc[-2:]}"
    out, bad = {}, 0
    for r in rows:
        cur, ly, last = fnum(r["營業收入-當月營收"]), fnum(r["營業收入-去年當月營收"]), fnum(r["營業收入-上月營收"])
        cum, cum_ly = fnum(r["累計營業收入-當月累計營收"]), fnum(r["累計營業收入-去年累計營收"])
        if cur is None or ly is None or cum is None or cum_ly is None:
            continue
        yoy = fnum(r["營業收入-去年同月增減(%)"])
        # 用原始金額重算年增率，和官方的百分比比對
        if ly > 0 and yoy is not None and abs((cur / ly - 1) * 100 - yoy) > 0.1:
            bad += 1
        out[r["公司代號"].strip()] = {
            "name": r["公司名稱"].strip(), "market": market, "industry": r.get("產業別", "").strip(),
            "rev": cur, "rev_ly": ly, "rev_last": last, "cum": cum, "cum_ly": cum_ly,
            "yoy": round((cur / ly - 1) * 100, 2) if ly > 0 else None,
            "mom": round((cur / last - 1) * 100, 2) if last and last > 0 else None,
            "cum_yoy": round((cum / cum_ly - 1) * 100, 2) if cum_ly > 0 else None,
            "note": (r.get("備註") or "").strip().strip("-").strip(),
        }
    if len(out) < min_count:
        raise RuntimeError(f"{market}營收只有 {len(out)} 家（少於 {min_count}），格式可能改版")
    if bad > max(3, len(out) * 0.02):
        raise RuntimeError(f"{market}營收年增率重算對不上：{bad}/{len(out)} 家")
    return ym, out


def load_revenue(get_json, gap):
    """抓最新一個月並存檔；回傳 {YYYYMM: {代號: {...}}}，新→舊，最多 KEEP_MONTHS 個月"""
    REV_DIR.mkdir(parents=True, exist_ok=True)
    ym1, tw = parse_revenue(get_json("https://openapi.twse.com.tw/v1/opendata/t187ap05_L"), "上市", 700)
    time.sleep(gap)
    ym2, tp = parse_revenue(get_json("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"), "上櫃", 600)
    if ym1 != ym2:
        # 月初公布期間兩邊可能差一個月：各存各的月份，篩選用兩邊共同的最新月份
        print(f"注意：上市營收 {ym1}、上櫃營收 {ym2} 月份不同")
    for ym, part in ((ym1, tw), (ym2, tp)):
        p = REV_DIR / f"{ym}.json"
        cur = json.loads(p.read_text()) if p.exists() else {}
        cur.update(part)
        p.write_text(json.dumps(cur, ensure_ascii=False, separators=(",", ":")))
    files = sorted(REV_DIR.glob("*.json"), reverse=True)
    for p in files[KEEP_MONTHS:]:
        p.unlink()
    return {p.stem: json.loads(p.read_text()) for p in files[:KEEP_MONTHS]}, min(ym1, ym2)


# ---------- 估值 ----------
def load_valuation(get_json, d, gap):
    """{代號: {"per", "pb", "dy"}}；本益比為 None 代表虧損或無資料"""
    out = {}
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date={d:%Y%m%d}&selectType=ALL&response=json")
    if j.get("stat") != "OK" or j.get("date") != f"{d:%Y%m%d}" or not j.get("data"):
        raise RuntimeError(f"證交所 {d} 本益比資料尚未公布")
    f = j["fields"]
    ic, ip, ib, iy = (f.index(k) for k in ("證券代號", "本益比", "股價淨值比", "殖利率(%)"))
    for r in j["data"]:
        out[r[ic].strip()] = {"per": fnum(r[ip]), "pb": fnum(r[ib]), "dy": fnum(r[iy])}
    time.sleep(gap)
    t = get_json(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date={d:%Y/%m/%d}&response=json")
    tb = (t.get("tables") or [None])[0]
    if str(t.get("date")) != f"{d:%Y%m%d}" or not tb or not tb.get("data"):
        raise RuntimeError(f"櫃買 {d} 本益比資料尚未公布")
    f = [x.strip() for x in tb["fields"]]
    ic, ip, ib, iy = (f.index(k) for k in ("股票代號", "本益比", "股價淨值比", "殖利率(%)"))
    for r in tb["data"]:
        out.setdefault(str(r[ic]).strip(), {"per": fnum(r[ip]), "pb": fnum(r[ib]), "dy": fnum(r[iy])})
    for v in out.values():
        if v["per"] is not None and v["per"] <= 0:
            v["per"] = None
    if len(out) < 1500:
        raise RuntimeError(f"本益比資料只有 {len(out)} 檔，格式可能改版")
    return out


# ---------- 篩選 ----------
def consecutive_months(months, start):
    """從 start 往前、月份連續不中斷的那幾個月（有缺月就停）"""
    out, y, m = [], int(start[:4]), int(start[4:])
    while f"{y}{m:02d}" in months:
        out.append(f"{y}{m:02d}")
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out


def pct_rank(vals, reverse=False):
    """{key: 值} -> {key: 0~1 的百分位}；reverse=True 代表值越小越好"""
    keys = sorted((k for k, v in vals.items() if v is not None), key=lambda k: vals[k], reverse=not reverse)
    n = len(keys)
    return {k: 1 - i / (n - 1) if n > 1 else 1.0 for i, k in enumerate(keys)}


def build(trade_date, quotes, inst_days, qall, index_rows, revenue, rev_ym, valuation, is_common_stock):
    """qall：PRICE_DAYS 個交易日行情（新→舊）；index_rows：FMTQIK 結果（舊→新）"""
    if len(qall) < PRICE_DAYS:
        raise RuntimeError(f"行情只有 {len(qall)} 天，不足 {PRICE_DAYS} 天")
    months = sorted(revenue, reverse=True)
    rev = revenue[rev_ym]
    idx = {r["date"]: r["index"] for r in index_rows}
    d0 = trade_date.isoformat()
    d60 = sorted(idx)[-PRICE_DAYS] if len(idx) >= PRICE_DAYS else None
    idx_ret = round((idx[d0] / idx[d60] - 1) * 100, 2) if d60 else None

    # 同產業本益比中位數（產業別取自營收表）
    by_ind = {}
    for c, r in rev.items():
        per = (valuation.get(c) or {}).get("per")
        if per:
            by_ind.setdefault(r["industry"], []).append(per)
    ind_med = {k: statistics.median(v) for k, v in by_ind.items() if len(v) >= 3}

    rows = {}
    for c, q in quotes.items():
        if not is_common_stock(c) or c not in rev or any(c not in qd for qd in qall[:21]):
            continue
        r = rev[c]
        vols = [qd[c][2] for qd in qall[1:21]]
        avg20 = sum(vols) / len(vols)
        if avg20 < MIN_AVG_VOL or r["rev_ly"] < MIN_REV_LY:
            continue
        # 還原股價（排除除權息與分割的跳動）：近 60 日漲幅與 60 日均價
        adj = adj_closes(qall, c, PRICE_DAYS - 1)
        ret60 = round((adj[0] / adj[-1] - 1) * 100, 2) if adj else None
        ma60 = sum(adj[:60]) / 60 if adj else None
        v = valuation.get(c) or {}
        med = ind_med.get(r["industry"])
        inst = sum(round((dd.get(c, [0] * 6)[0] + dd.get(c, [0] * 6)[1]) / 1000) for _, dd in inst_days[:INST_DAYS])
        # 有歷史月份時才算：連續 3 個月年增 > REV_YOY、當月營收是近 12 個月新高
        hist = [revenue[m].get(c) for m in consecutive_months(months, rev_ym)]
        yoy3 = len(hist) >= 3 and all(h and h["yoy"] is not None and h["yoy"] > REV_YOY for h in hist[:3])
        high12 = len(hist) >= 12 and all(h and r["rev"] >= h["rev"] for h in hist[:12])
        rows[c] = {
            "code": c, "name": q["name"], "market": q["market"], "industry": r["industry"],
            "close": q["close"], "pct": q["pct"], "volume": q["volume"], "avg20": round(avg20),
            "vol_ratio": round(q["volume"] / avg20, 2) if avg20 else None,
            "rev": round(r["rev"] / 1e5, 2), "yoy": r["yoy"], "mom": r["mom"], "cum_yoy": r["cum_yoy"], "note": r["note"],
            "yoy3": yoy3 if len(hist) >= 3 else None, "high12": high12 if len(hist) >= 12 else None,
            "per": v.get("per"), "pb": v.get("pb"), "dy": v.get("dy"), "ind_per": round(med, 2) if med else None,
            "ret60": ret60, "rel60": round(ret60 - idx_ret, 2) if ret60 is not None and idx_ret is not None else None,
            "below_ma60": adj[0] < ma60 if ma60 else None, "inst10": inst,
        }
        x = rows[c]
        x["c_rev"] = bool(x["yoy"] is not None and x["yoy"] > REV_YOY and x["cum_yoy"] is not None and x["cum_yoy"] > REV_CUM_YOY)
        x["c_val"] = bool(x["per"] and (x["per"] < PER_MAX or (med and x["per"] < med)))
        x["c_lag"] = bool((x["rel60"] is not None and x["rel60"] < 0) or x["below_ma60"])
        x["c_inst"] = inst <= 0

    # 綜合分數：年增率越高、本益比越低、近 60 日相對大盤越落後，分數越高（0～100）
    ry = pct_rank({c: x["yoy"] for c, x in rows.items()})
    rp = pct_rank({c: x["per"] for c, x in rows.items()}, reverse=True)
    rl = pct_rank({c: x["rel60"] for c, x in rows.items()}, reverse=True)
    for c, x in rows.items():
        parts = [p for p in (ry.get(c), rp.get(c), rl.get(c)) if p is not None]
        x["score"] = round(sum(parts) / 3 * 100, 1) if len(parts) == 3 else None

    return {
        "date": d0, "rev_month": rev_ym, "rev_months": len(consecutive_months(months, rev_ym)),
        "index_ret60": idx_ret, "index_from": d60,
        "rules": {"min_avg_vol": MIN_AVG_VOL, "min_rev_ly": MIN_REV_LY // 100000, "rev_yoy": REV_YOY,
                  "rev_cum_yoy": REV_CUM_YOY, "per_max": PER_MAX, "inst_days": INST_DAYS},
        "rows": sorted(rows.values(), key=lambda x: -(x["score"] or -1)),
    }


def write(v):
    OUT.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
