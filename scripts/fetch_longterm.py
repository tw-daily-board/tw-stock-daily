"""長期體質篩選：用每月一次的本益比、殖利率、股價淨值比，反推近 5 年的 EPS、現金股利、每股淨值與 ROE。

證交所與櫃買的財報 OpenAPI 只有最新一期，所以改用估值表的歷史（可指定日期）反推：
  近四季 EPS ＝ 收盤價 ÷ 本益比（虧損時本益比為「-」，只能標示虧損）
  現金股利   ＝ 收盤價 × 殖利率（櫃買直接提供每股股利）
  每股淨值   ＝ 收盤價 ÷ 股價淨值比
  ROE        ≈ 近四季 EPS ÷ 每股淨值
這些是由四捨五入後的比率反推的近似值，不是財報原始數字。

資料來源：證交所 exchangeReport/BWIBBU_d（上市，含收盤價）、櫃買 afterTrading/peQryDate（上櫃）＋ afterTrading/otc（上櫃收盤價）
每月取 15 日（遇假日往後找）那天，快取在 data/valhist/YYYYMM.json，保留 61 個月；抓不到的月份下次排程再補，不用替代數字。
輸出 data/longterm.json。全部用固定規則計算，不用 LLM。
"""
import json
import statistics
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST_DIR = ROOT / "data" / "valhist"
OUT = ROOT / "data" / "longterm.json"
MONTHS = 61               # 今月往前 60 個月（5 年）
YEARS = 5
MAX_FETCH_PER_RUN = 70    # 每次執行最多回補幾個月（第一次回補分批也沒關係）

# 篩選門檻（網頁可個別開關條件，門檻本身改這裡）
ROE_MIN = 12              # 5 年每個年度點的 ROE 都 ≥ 12%
EXPECT_MIN = 8            # 殖利率＋EPS 年化成長 ≥ 8%
MIN_AVG_VOL = 100         # 排除：近 20 日均量不到 100 張
AI_INDUSTRIES = ["半導體業", "電子零組件業", "電腦及週邊設備業", "光電業", "通信網路業", "其他電子業", "電子通路業", "資訊服務業"]
# 電信業者在證交所歸在「通信網路業」（和網通設備同類），但不是 AI／電子製造，排除 AI 時保留
TELECOM = {"2412": "中華電", "3045": "台灣大", "4904": "遠傳"}


def fnum(s):
    try:
        v = float(str(s).replace(",", "").strip())
        return v
    except ValueError:
        return None


def month_list(today):
    """近 MONTHS 個月的 (年, 月)，新→舊；當月要過了 15 日才算"""
    y, m = today.year, today.month
    if today.day < 15:
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    out = []
    for _ in range(MONTHS):
        out.append((y, m))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out


# ---------- 抓某月的估值快照 ----------
def fetch_twse(get_json, d):
    j = get_json(f"https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date={d:%Y%m%d}&selectType=ALL")
    if j.get("stat") != "OK" or j.get("date") != f"{d:%Y%m%d}" or not j.get("data"):
        return None
    f = j["fields"]
    ic, icl, iy, ip, ib = (f.index(k) for k in ("證券代號", "收盤價", "殖利率(%)", "本益比", "股價淨值比"))
    out = {}
    for r in j["data"]:
        close, dy = fnum(r[icl]), fnum(r[iy])
        if close:
            out[r[ic].strip()] = [close, fnum(r[ip]), fnum(r[ib]), round(close * dy / 100, 4) if dy is not None else None]
    return out


def fetch_tpex(get_json, fetch_tpex_quotes, d):
    t = get_json(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date={d:%Y/%m/%d}&response=json")
    tb = (t.get("tables") or [None])[0]
    if str(t.get("date")) != f"{d:%Y%m%d}" or not tb or not tb.get("data"):
        raise RuntimeError(f"櫃買 {d} 本益比抓不到（上市有資料）")
    f = [x.strip() for x in tb["fields"]]
    ic, ip, ib, idps = (f.index(k) for k in ("股票代號", "本益比", "股價淨值比", "每股股利"))
    time.sleep(2)
    quotes = fetch_tpex_quotes(d)
    out = {}
    for r in tb["data"]:
        c = str(r[ic]).strip()
        q = quotes.get(c)
        if q:
            out[c] = [q["close"], fnum(r[ip]), fnum(r[ib]), fnum(r[idps])]
    return out


def fetch_month(get_json, fetch_tpex_quotes, y, m, gap):
    """取 y/m 月 15 日起第一個有資料的交易日；回傳 {"_date": ..., 代號: [收盤, 本益比, 淨值比, 每股現金股利]}"""
    for day in range(15, 26):
        d = date(y, m, day)
        if d.weekday() >= 5 or d > date.today():
            continue
        time.sleep(gap)
        tw = fetch_twse(get_json, d)
        if tw is None:
            continue
        time.sleep(gap)
        tp = fetch_tpex(get_json, fetch_tpex_quotes, d)
        return {"_date": d.isoformat(), **tp, **tw}
    return None


def load_history(get_json, fetch_tpex_quotes, today, gap, warn):
    HIST_DIR.mkdir(parents=True, exist_ok=True)
    months = month_list(today)
    fetched = 0
    for y, m in months:
        p = HIST_DIR / f"{y}{m:02d}.json"
        if p.exists() or fetched >= MAX_FETCH_PER_RUN:
            continue
        try:
            rec = fetch_month(get_json, fetch_tpex_quotes, y, m, gap)
        except Exception as e:  # noqa: BLE001
            warn(f"估值歷史 {y}/{m:02d} 未抓到（下次排程再補）", e)
            time.sleep(30)  # 證交所限流時先停一下
            continue
        fetched += 1
        if rec:
            p.write_text(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
        else:
            warn(f"估值歷史 {y}/{m:02d} 找不到交易日", RuntimeError("15～25 日都沒有資料"))
    keep = {f"{y}{m:02d}.json" for y, m in months}
    for p in HIST_DIR.glob("*.json"):
        if p.name not in keep:
            p.unlink()
    return {f"{y}{m:02d}": json.loads((HIST_DIR / f"{y}{m:02d}.json").read_text())
            for y, m in months if (HIST_DIR / f"{y}{m:02d}.json").exists()}


# ---------- 指標 ----------
def derive(v):
    """[收盤, 本益比, 淨值比, 股利] -> (EPS, 每股淨值, 股利)；本益比為空代表虧損或無資料"""
    close, per, pb, dps = v
    eps = round(close / per, 2) if per and per > 0 else None
    bvps = round(close / pb, 2) if pb and pb > 0 else None
    return eps, bvps, dps


def cagr(a, b, years):
    return round(((a / b) ** (1 / years) - 1) * 100, 2) if a and b and a > 0 and b > 0 else None


def build(today, quotes, qall, valuation, revenue_rows, hist, is_common_stock):
    months = sorted(hist, reverse=True)
    # 年度點：今天（今日估值）＋ 每年同月份（例如 2025/10、2024/10…），報告落後時間一致，可比較
    cur_m = months[0] if months else None
    yearly = [cur_m] + [f"{int(cur_m[:4]) - k}{cur_m[4:]}" for k in range(1, YEARS + 1)] if cur_m else []
    rows = []
    for c, q in quotes.items():
        if not is_common_stock(c) or c not in valuation:
            continue
        vols = [qd[c][2] for qd in (qall or [])[1:21] if c in qd]
        if not vols or sum(vols) / len(vols) < MIN_AVG_VOL:
            continue
        now = valuation[c]
        v_now = [q["close"], now.get("per"), now.get("pb"), round(q["close"] * now["dy"] / 100, 4) if now.get("dy") is not None else None]
        pts = []                     # 年度點：今天、1 年前…5 年前
        for i, ym in enumerate(yearly):
            v = v_now if i == 0 else (hist.get(ym) or {}).get(c)
            pts.append((ym, derive(v) if v else None))
        if any(p is None for _, p in pts):
            continue                 # 上市不滿 5 年或有月份還沒回補
        eps = [p[0] for _, p in pts]
        bvps = [p[1] for _, p in pts]
        dps = [p[2] for _, p in pts]
        roe = [round(e / b * 100, 2) if e is not None and b else None for e, b in zip(eps, bvps)]
        per_hist = [hist[m][c][1] for m in months if c in hist[m] and hist[m][c][1]]
        per_med = statistics.median(per_hist) if len(per_hist) >= 24 else None
        g = cagr(eps[0], eps[-1], YEARS)
        dy = now.get("dy")
        industry = (revenue_rows.get(c) or {}).get("industry", "")
        x = {
            "code": c, "name": q["name"], "market": q["market"], "industry": industry, "close": q["close"],
            "dy": dy, "per": now.get("per"), "pb": now.get("pb"), "per_med5": round(per_med, 2) if per_med else None,
            "eps_cagr": g, "expect": round(dy + g, 2) if dy is not None and g is not None else None,
            "roe_min": min(roe) if all(r is not None for r in roe) else None, "roe_now": roe[0],
            "years": [{"ym": ym, "eps": e, "dps": d, "roe": r} for (ym, _), e, d, r in zip(pts, eps, dps, roe)],
            "ai": industry in AI_INDUSTRIES and c not in TELECOM,
        }
        x["c_roe"] = bool(x["roe_min"] is not None and x["roe_min"] >= ROE_MIN)
        x["c_eps"] = bool(all(e is not None and e > 0 for e in eps) and g is not None and g > 0)
        x["c_div"] = all(d is not None and d > 0 for d in dps)
        x["c_expect"] = bool(x["expect"] is not None and x["expect"] >= EXPECT_MIN)
        x["c_cheap"] = bool(x["per"] and per_med and x["per"] < per_med)
        rows.append(x)
    rows.sort(key=lambda r: -(r["expect"] if r["expect"] is not None else -999))
    return {
        "date": today.isoformat(), "months": len(months), "need_months": MONTHS,
        "yearly": yearly, "ai_industries": AI_INDUSTRIES, "telecom": list(TELECOM.values()),
        "rules": {"roe_min": ROE_MIN, "expect_min": EXPECT_MIN, "min_avg_vol": MIN_AVG_VOL, "years": YEARS},
        "rows": rows,
    }


def write(v):
    OUT.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
