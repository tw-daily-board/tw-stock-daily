"""台指期盤後快訊：收盤行情表、三大法人籌碼變化、十大交易人期權淨部位。

資料全部來自期交所網站的 CSV 下載（可指定日期，所以前一交易日也能直接查，不需自己存歷史）與證交所：
  - 每日行情     cht/3/futDataDown
  - 三大法人     cht/3/futContractsDateDown、cht/3/callsAndPutsDateDown
  - 大額交易人   cht/3/largeTraderFutDown、cht/3/largeTraderOptDown
  - 選擇權行情   cht/3/optDataDown（逐履約價未平倉，找支撐壓力）；P/C 比 cht/3/pcRatioDown
  - 現貨買賣超   證交所 BFI82U；加權指數與成交金額 證交所 FMTQIK
不用 openapi.taifex.com.tw：它比網站晚更新（當天晚上仍是前一交易日）。
"""
import csv
import io
import json
import math
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

TAIFEX = "https://www.taifex.com.tw/cht/3/"
FUT_DIR = Path(__file__).resolve().parent.parent / "data" / "fut"
KEEP_SNAPSHOTS = 6       # 今天＋前 5 個交易日（散戶多空比用前 5 日平均）
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}

# 收盤行情表：(顯示名稱, 契約代號, 取幾個月份)；近月＋次月，分類指數期只取近月
QUOTE_ROWS = [("台指", "TX", 2), ("小台", "MTX", 2), ("微台", "TMF", 2),
              ("電子", "TE", 1), ("金融", "TF", 1), ("非金", "XIF", 1)]
INST_NAMES = {"自營商": "dl", "投信": "it", "外資及陸資": "fi"}
ALL_MONTHS = ("999912", "999999")   # 大額交易人「所有契約」
SKIP_MONTHS = ("666666",) + ALL_MONTHS  # 666666＝週契約合計
OPT_SERIES = 3          # 顯示最近到期的幾個系列
OPT_KEEP_DAYS = 40      # 快照只存這麼多天內到期的系列（算未平倉變化用）
SR_RANGE = 0.15         # 支撐壓力只在指數上下 15% 內找，排除遠價外舊倉
CHART_RANGE = 0.10      # 分布圖畫指數上下 10%
CHART_MIN_OI = 800      # 分布圖只畫買權或賣權至少一邊未平倉達 800 口的履約價
WEEKDAY = "一二三四五六日"
BUILD_TOP = 5           # 建倉熱區：每邊列未平倉增加最多的幾個履約價
BUILD_MIN = 200         # 未平倉至少增加這麼多口才列入
IV_TH = 1.0             # 隱含波動率變化（百分點）超過這個門檻才推測買方或賣方
MIN_PREMIUM = 1.0       # 權利金低於 1 點時隱含波動率不可靠，不推測


class NotPublished(RuntimeError):
    pass


def fnum(s):
    try:
        return float(str(s).replace(",", "").replace("%", "").replace("+", "").strip())
    except ValueError:
        return None


def get_csv(path, params, gap=1.0, retries=4):
    """下載期交所 CSV（Big5）；沒有資料列（假日、尚未公布）回傳空 list。"""
    url = TAIFEX + path + "?" + params
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                text = r.read().decode("cp950", "replace")
            time.sleep(gap)
            return list(csv.DictReader(io.StringIO(text)))
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            print(f"[retry {i + 1}/{retries}] {url} -> {last}", file=sys.stderr)
            time.sleep(2 ** (i + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def rng(d):
    return f"queryStartDate={d:%Y/%m/%d}&queryEndDate={d:%Y/%m/%d}"


def clean(r):
    return {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in r.items() if k}


def check_day(rows, d, what):
    rows = [clean(r) for r in rows]
    rows = [r for r in rows if r.get(next(iter(r), ""), "").replace("/", "-") == d.isoformat()] if rows else []
    if not rows:
        raise NotPublished(f"期交所 {d} {what} 無資料（假日或尚未公布）")
    return rows


def day_rows(path, params, d, what, tries=3):
    """下載並取出當日資料列。期交所偶爾回傳空內容，空的時候先重試幾次，確定沒有才算尚未公布。"""
    for i in range(tries):
        try:
            return check_day(get_csv(path, params), d, what)
        except NotPublished:
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


# ---------- 收盤行情 ----------
def parse_quotes(d):
    """回傳 (各契約各月份行情, 各契約全市場未平倉＝所有月份＋週契約的一般盤未沖銷契約數，不含價差單)"""
    out, oi_total = {}, {}
    for code in [c for _, c, _ in QUOTE_ROWS]:
        rows = day_rows("futDataDown", f"down_type=1&commodity_id={code}&commodity_id2=&{rng(d)}", d, f"{code} 行情")
        months = {}
        oi_total[code] = sum(int(fnum(r["未沖銷契約數"]) or 0) for r in rows
                             if r["契約"] == code and r["交易時段"] == "一般" and "/" not in r["到期月份(週別)"])
        for r in rows:
            m = r["到期月份(週別)"]
            if r["契約"] != code or not m.isdigit() or len(m) != 6:
                continue
            q = months.setdefault(m, {"vol": 0, "settle": None, "oi": None, "ref": None})
            q["vol"] += int(fnum(r["成交量"]) or 0)                     # 一般 + 盤後
            if r["交易時段"] == "一般":
                q["settle"] = fnum(r["結算價"])
                q["oi"] = fnum(r["未沖銷契約數"])
                last, chg = fnum(r["收盤價"]), fnum(r["漲跌價"])
                if last is not None and chg is not None:
                    q["ref"] = round(last - chg, 4)                      # 前一日結算價
        out[code] = months
    return out, oi_total


# ---------- 三大法人 ----------
RETAIL = [("TX", "臺股期貨", "台指（TXF）"), ("MTX", "小型臺指期貨", "小台（MXF）"), ("TMF", "微型臺指期貨", "微台（TMF）")]


def parse_inst(d):
    """回傳 (三大法人台指期與台指選擇權淨部位, 三大法人合計在 TX/MTX/TMF 的多空未平倉與多空交易口數)"""
    fut = day_rows("futContractsDateDown", rng(d), d, "三大法人期貨")
    opt = day_rows("callsAndPutsDateDown", rng(d) + "&commodityId=TXO", d, "三大法人選擇權")
    out = {k: {} for k in INST_NAMES.values()}
    cps = {k: {} for k in INST_NAMES.values()}  # 買方、賣方未平倉分開（口、億元）
    for r in fut:
        if r["商品名稱"] == "臺股期貨" and r["身份別"] in INST_NAMES:
            out[INST_NAMES[r["身份別"]]]["fut"] = int(fnum(r["多空未平倉口數淨額"]))
    for r in opt:
        if r["商品名稱"] == "臺指選擇權" and r["身份別"] in INST_NAMES:
            k, cp = INST_NAMES[r["身份別"]], r["買賣權別"].lower()
            out[k][cp] = int(fnum(r["未平倉口數買賣淨額"]))
            out[k][cp + "_amt"] = round(fnum(r["未平倉契約金額買賣淨額(千元)"]) / 1e5, 2)  # 千元→億
            cps[k][cp] = {"b": int(fnum(r["買方未平倉口數"])), "s": int(fnum(r["賣方未平倉口數"])),
                          "b_amt": round(fnum(r["買方未平倉契約金額(千元)"]) / 1e5, 2), "s_amt": round(fnum(r["賣方未平倉契約金額(千元)"]) / 1e5, 2)}
    for k, v in out.items():
        if len(v) != 5:
            raise RuntimeError(f"三大法人 {k} 欄位不全：{v}")
        if set(cps[k]) != {"call", "put"}:
            raise RuntimeError(f"三大法人選擇權 {k} 買賣權分計不全：{cps[k]}")
    inst_fut = {}
    for code, name, _ in RETAIL:
        rs = [r for r in fut if r["商品名稱"] == name and r["身份別"] in INST_NAMES]
        if len(rs) != 3:
            raise RuntimeError(f"三大法人 {name} 應有 3 種身份別，實際 {len(rs)} 筆")
        g = lambda k: sum(int(fnum(r[k])) for r in rs)  # noqa: E731
        inst_fut[code] = {"L": g("多方未平倉口數"), "S": g("空方未平倉口數"), "TL": g("多方交易口數"), "TS": g("空方交易口數")}
    return out, inst_fut, cps


# ---------- 十大交易人 ----------
def parse_large(d):
    f = day_rows("largeTraderFutDown", f"{rng(d)}&contractId=TX", d, "十大交易人期貨")
    o = day_rows("largeTraderOptDown", f"{rng(d)}&contractId=TXO", d, "十大交易人選擇權")

    def board(rows, match):
        """{月份: {類型: 十大買-十大賣}}；類型 0＝全部交易人、1＝特定法人；所有到期月份＝ALL_MONTHS"""
        net, oi = {}, {}
        for r in rows:
            if not match(r):
                continue
            m, t = r["到期月份(週別)"], r["交易人類別"]
            net.setdefault(m, {})[t] = int(fnum(r["前十大交易人買方"]) - fnum(r["前十大交易人賣方"]))
            oi[m] = int(fnum(r["全市場未沖銷部位數"]))
        allm = next((m for m in ALL_MONTHS if m in net), None)
        months = sorted(m for m in net if m.isdigit() and m not in SKIP_MONTHS)
        if not months or allm is None:
            raise RuntimeError("十大交易人缺少月份資料")
        near = months[0]
        spec_n, spec_a = net[near]["1"], net[allm]["1"]
        all_n, all_a = net[near]["0"], net[allm]["0"]
        return {"month": near, "oi": oi[allm], "sp_near": spec_n, "sp_far": spec_a - spec_n,
                "ot_near": all_n - spec_n, "ot_far": (all_a - spec_a) - (all_n - spec_n)}

    return {
        "fut": board(f, lambda r: r["商品(契約)"] == "TX"),
        "call": board(o, lambda r: r["商品(契約)"] == "TXO" and r["買賣權"] == "買權"),
        "put": board(o, lambda r: r["商品(契約)"] == "TXO" and r["買賣權"] == "賣權"),
    }


# ---------- 選擇權逐履約價未平倉 ----------
def parse_opt(d):
    """{系列: {"exp": 到期日, "c": {履約價: OI}, "p": {...}}}；系列如 202610（月選）、202610W4（週三）、202610F4（週五）"""
    rows = day_rows("optDataDown", f"down_type=1&commodity_id=TXO&commodity_id2=&{rng(d)}", d, "選擇權行情")
    out = {}
    for r in rows:
        if r["交易時段"] != "一般" or r["契約"] != "TXO":
            continue
        oi = fnum(r["未沖銷契約數"])
        exp = r["契約到期日"]
        if not oi or (date(int(exp[:4]), int(exp[4:6]), int(exp[6:8])) - d).days > OPT_KEEP_DAYS:
            continue
        s = out.setdefault(r["到期月份(週別)"], {"exp": exp, "c": {}, "p": {}, "px": {"c": {}, "p": {}}, "vol": {"c": {}, "p": {}}})
        side, k = "c" if r["買賣權"] == "買權" else "p", str(int(fnum(r["履約價"])))
        s[side][k] = int(oi)
        s["vol"][side][k] = int(fnum(r["成交量"]) or 0)
        if fnum(r["結算價"]) is not None:
            s["px"][side][k] = fnum(r["結算價"])
    if not out:
        raise RuntimeError("選擇權行情解析不到任何未平倉")
    return out


def fetch_pc(d):
    """近 10 個交易日的 P/C 比（%）：成交量、未平倉"""
    rows = get_csv("pcRatioDown", f"queryStartDate={d - timedelta(days=21):%Y/%m/%d}&queryEndDate={d:%Y/%m/%d}")
    out = []
    for r in map(clean, rows):
        if r.get("日期"):
            out.append({"date": r["日期"].replace("/", "-"), "vol": fnum(r["買賣權成交量比率%"]), "oi": fnum(r["買賣權未平倉量比率%"])})
    return sorted(out, key=lambda x: x["date"])[-10:]


def opt_view(snap, prev, ref):
    """最近到期的幾個系列：支撐（指數以下賣權 OI 最大）、壓力（指數以上買權 OI 最大）、P/C、分布圖資料"""
    after = [(k, v) for k, v in snap["opt"].items() if v["exp"] > snap["date"].replace("-", "")]
    out = []
    for code, s in sorted(after, key=lambda kv: kv[1]["exp"])[:OPT_SERIES]:
        ps = ((prev or {}).get("opt") or {}).get(code)
        e = date(int(s["exp"][:4]), int(s["exp"][4:6]), int(s["exp"][6:8]))
        kind = "週選" if any(x in code[6:] for x in "WF") else "月選"
        dif = lambda side, k: None if ps is None else s[side].get(k, 0) - ps[side].get(k, 0)  # noqa: E731

        def top(side, rng):
            # 壓力：指數以上的買權；支撐：指數以下的賣權（價內的部位不算支撐壓力）
            ks = [k for k in s[side] if abs(int(k) - ref) <= ref * rng and (int(k) >= ref if side == "c" else int(k) <= ref)]
            ks.sort(key=lambda k: -s[side][k])
            return [{"strike": int(k), "oi": s[side][k], "d": dif(side, k)} for k in ks[:3]]

        resist, support = top("c", SR_RANGE), top("p", SR_RANGE)
        # 分布圖：雙邊都未達 CHART_MIN_OI 的價位不畫；支撐壓力價位一定畫（即使在 10% 外或未達門檻）
        strikes = sorted({int(k) for side in "cp" for k in s[side] if abs(int(k) - ref) <= ref * CHART_RANGE
                          and max(s["c"].get(k, 0), s["p"].get(k, 0)) >= CHART_MIN_OI}
                         | {x["strike"] for x in resist + support})
        tc, tp = sum(s["c"].values()), sum(s["p"].values())
        out.append({
            "code": code, "exp": e.isoformat(), "label": f"{e.month}/{e.day}（{WEEKDAY[e.weekday()]}）{kind}",
            "call_oi": tc, "put_oi": tp, "pc": round(tp / tc * 100, 1) if tc else None,
            "resist": resist, "support": support,
            "rows": [[k, s["c"].get(str(k), 0), s["p"].get(str(k), 0), dif("c", str(k)), dif("p", str(k))] for k in strikes],
        })
    return {"ref": ref, "series": out, "sr_range": SR_RANGE, "chart_range": CHART_RANGE, "chart_min_oi": CHART_MIN_OI}


# ---------- 現貨（證交所） ----------
def fetch_cash(get_json, d):
    """三大法人現貨買賣超金額（億元）與加權指數、成交金額（兆元）"""
    j = get_json(f"https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate={d:%Y%m%d}&type=day&response=json")
    if j.get("stat") != "OK":
        raise RuntimeError("BFI82U 無資料")
    rows = {r[0].strip(): fnum(r[3]) for r in j["data"]}
    fi = rows["外資及陸資(不含外資自營商)"] + rows.get("外資自營商", 0)
    dl = rows["自營商(自行買賣)"] + rows["自營商(避險)"]
    cash = {"fi": fi, "it": rows["投信"], "dl": dl}
    time.sleep(3)
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date={d:%Y%m%d}&response=json")
    row = next((r for r in j.get("data", []) if r[0].replace("/", "") == f"{d.year - 1911}{d:%m%d}"), None)
    if row is None:
        raise RuntimeError("FMTQIK 找不到當日")
    idx = {"close": fnum(row[4]), "change": fnum(row[5]), "value_tril": fnum(row[2]) / 1e12}
    idx["pct"] = round(idx["change"] / (idx["close"] - idx["change"]) * 100, 2)
    return {k: round(v / 1e8, 2) for k, v in cash.items()}, idx


# ---------- 快照與組表 ----------
def snapshot(d):
    quotes, oi_total = parse_quotes(d)
    inst, inst_fut, inst_opt = parse_inst(d)
    return {"date": d.isoformat(), "quotes": quotes, "oi_total": oi_total, "inst": inst, "inst_fut": inst_fut, "inst_opt": inst_opt,
            "large": parse_large(d), "opt": parse_opt(d)}


def load_snapshot(d):
    """先看 data/fut/ 有沒有快取，沒有才向期交所抓"""
    p = FUT_DIR / f"{d:%Y%m%d}.json"
    if p.exists():
        snap = json.loads(p.read_text())
        # 舊版快照缺選擇權、散戶計算或建倉分析所需欄位就重抓
        if "inst_fut" in snap and "inst_opt" in snap and all("px" in v for v in snap.get("opt", {}).values()):
            return snap
    snap = snapshot(d)
    FUT_DIR.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
    return snap


def previous_snapshot(d):
    """往前找最近一個有資料的交易日（最多 10 天）"""
    for i in range(1, 11):
        if (d - timedelta(days=i)).weekday() >= 5:
            continue
        try:
            return load_snapshot(d - timedelta(days=i))
        except NotPublished:
            continue
    return None


def build(get_json, trade_date: date, gap=3.0):
    # 當天的資料不用快取，確保晚間補公布的內容會更新
    (FUT_DIR / f"{trade_date:%Y%m%d}.json").unlink(missing_ok=True)
    snap = load_snapshot(trade_date)
    prev = previous_snapshot(trade_date)
    for p in sorted(FUT_DIR.glob("*.json"))[:-KEEP_SNAPSHOTS]:
        p.unlink()
    # 散戶多空比近幾日走勢：用 data/fut/ 裡保留的快照（舊版快照會自動重抓補欄位）
    trend = []
    for p in sorted(FUT_DIR.glob("*.json")):
        d = date.fromisoformat(f"{p.stem[:4]}-{p.stem[4:6]}-{p.stem[6:]}")
        if d <= trade_date:
            trend.append(retail_rows(load_snapshot(d)))
    time.sleep(gap)
    cash, idx = fetch_cash(get_json, trade_date)
    out = compose(snap, prev, cash, idx)
    out["retail"] = retail_view(snap, prev, trend)
    out["opt"] = opt_view(snap, prev, idx["close"])
    out["pc"] = fetch_pc(trade_date)
    # 建倉分析獨立：出錯只讓這一頁顯示「尚未產生」，台指期與支撐壓力照常更新
    try:
        out["build"] = build_view(snap, prev, idx["close"])
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"
        print(f"選擇權建倉分析失敗：{msg}", file=sys.stderr)
        print("::error title=選擇權建倉分析未產生::" + msg[:500].replace("\n", " "))
        out["build"] = None
    return out


# ---------- 散戶多空比（坊間算法） ----------
# 散戶多單＝全市場未平倉－三大法人多單；散戶空單＝全市場未平倉－三大法人空單；
# 散戶多空比＝(散戶多單－散戶空單)÷全市場未平倉×100%；散戶當日交易淨口數＝三大法人空方交易－多方交易
def retail_rows(snap):
    rows = {}
    for code, _, label in RETAIL:
        oi, src = snap["oi_total"][code], snap["inst_fut"][code]
        rl, rs = oi - src["L"], oi - src["S"]
        rows[code] = {"label": label, "oi": oi, "long": rl, "short": rs, "net": rl - rs,
                      "ratio": round((rl - rs) / oi * 100, 2) if oi else None, "trade_net": src["TS"] - src["TL"]}
    return {"date": snap["date"], "rows": rows}


def retail_view(snap, prev, trend):
    cur, old = retail_rows(snap), retail_rows(prev) if prev and "inst_fut" in prev else None
    rows = []
    for code, _, _ in RETAIL:
        r, o = cur["rows"][code], (old or {}).get("rows", {}).get(code)
        rows.append({**r, "code": code, "net_d": None if not o else r["net"] - o["net"],
                     "ratio_d": None if not o or r["ratio"] is None or o["ratio"] is None else round(r["ratio"] - o["ratio"], 2)})
    return {"date": snap["date"], "rows": rows,
            "trend": [{"date": t["date"], **{c: t["rows"][c]["ratio"] for c, _, _ in RETAIL}} for t in trend]}


def delta(cur, old):
    return None if old is None else round(cur - old, 2)


def compose(snap, prev, cash, idx):
    # 收盤行情表
    market = []
    for label, code, n in QUOTE_ROWS:
        months = sorted(snap["quotes"][code])
        # 近月：最小的月份；已到期（無一般盤結算價）的略過
        months = [m for m in months if snap["quotes"][code][m]["settle"] is not None][:n]
        for m in months:
            q = snap["quotes"][code][m]
            pq = (prev or {}).get("quotes", {}).get(code, {}).get(m)
            ref = pq["settle"] if pq and pq.get("settle") is not None else q["ref"]
            chg = None if ref is None else round(q["settle"] - ref, 2)
            market.append({
                "name": f"{label}{m[4:]}", "close": q["settle"], "change": chg,
                "pct": None if not ref else round(chg / ref * 100, 2),
                "volume": q["vol"], "oi": int(q["oi"]), "oi_chg": None if not pq or pq.get("oi") is None else int(q["oi"] - pq["oi"]),
            })
    # 三大法人籌碼變化（口數）；合計為三者相加
    inst = []
    for key, label in (("fi", "外資"), ("it", "投信"), ("dl", "自營商")):
        inst.append({"name": label, "cash": cash[key], **{k: snap["inst"][key][k] for k in snap["inst"][key]},
                     **{k + "_d": delta(snap["inst"][key][k], (prev or {}).get("inst", {}).get(key, {}).get(k)) for k in snap["inst"][key]}})
    tot = {"name": "合計", "cash": round(sum(r["cash"] for r in inst), 2)}
    for k in ("fut", "call", "put", "call_amt", "put_amt"):
        tot[k] = round(sum(r[k] for r in inst), 2)
        tot[k + "_d"] = None if any(r[k + "_d"] is None for r in inst) else round(sum(r[k + "_d"] for r in inst), 2)
    inst.append(tot)
    # 十大交易人淨部位
    large = []
    for key, label in (("fut", "台指"), ("call", "買權"), ("put", "賣權")):
        cur, old = snap["large"][key], (prev or {}).get("large", {}).get(key)
        row = {"name": label}
        for k in ("sp_near", "sp_far", "ot_near", "ot_far", "oi"):
            row[k] = cur[k]
            row[k + "_d"] = None if not old else cur[k] - old[k]
        large.append(row)
    return {"date": snap["date"], "prev_date": prev["date"] if prev else None, "index": idx,
            "market": market, "inst": inst, "large": large}


# ---------- 選擇權建倉分析 ----------
# 官方資料：三大法人選擇權買賣權分計（買方、賣方未平倉分開）。
# 推測：逐履約價未平倉增加時，用隱含波動率變化推測偏買方或偏賣方建倉。每一口未平倉都同時有買方與賣方，
# 公開資料看不出是誰新增部位，也無法得知不同履約價是否為同一人所建，所以只能推測、必須標示。
def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def black76(F, K, T, sig, call):
    """利率設 0 的 Black-76 選擇權理論價（以台指期結算價為標的）"""
    if sig <= 0 or T <= 0:
        return max(F - K, 0) if call else max(K - F, 0)
    v = sig * math.sqrt(T)
    d1 = (math.log(F / K) + v * v / 2) / v
    d2 = d1 - v
    return F * _ncdf(d1) - K * _ncdf(d2) if call else K * _ncdf(-d2) - F * _ncdf(-d1)


def implied_vol(price, F, K, T, call):
    """二分法反推隱含波動率；權利金太低或低於內含價值時回傳 None"""
    if price is None or price < MIN_PREMIUM or T <= 0:
        return None
    if price <= (max(F - K, 0) if call else max(K - F, 0)) + 0.01:
        return None
    lo, hi = 0.001, 5.0
    if black76(F, K, T, hi, call) < price:
        return None
    for _ in range(80):
        mid = (lo + hi) / 2
        if black76(F, K, T, mid, call) < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def trading_years(d, exp):
    """距到期的交易日數（週一到週五，不含國定假日）÷ 252；週末不算時間價值，週一的波動率才不會被週末扭曲"""
    days, x = 0, d
    while x < exp:
        x += timedelta(days=1)
        if x.weekday() < 5:
            days += 1
    return days / 252


def forward(snap, code):
    """系列對應的台指期結算價：同月份（未到期）或之後最近的月份"""
    qs = snap["quotes"]["TX"]
    ms = sorted(m for m in qs if m >= code[:6] and qs[m]["settle"] is not None)
    return qs[ms[0]]["settle"] if ms else None


def smile(s, side, F, T):
    """[(log(K/F), IV)]，依 log 價內外程度排序"""
    pts = []
    for k, p in s["px"][side].items():
        iv = implied_vol(p, F, int(k), T, side == "c")
        if iv is not None:
            pts.append((math.log(int(k) / F), iv))
    return sorted(pts)


def interp(pts, x):
    """線性內插；超出範圍不外插"""
    if not pts or x < pts[0][0] or x > pts[-1][0]:
        return None
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


def atm_iv(s, F, T):
    """價平隱含波動率：價外那一邊（指數以下用賣權、以上用買權）在價平處內插"""
    otm = [x for x in smile(s, "p", F, T) if x[0] <= 0] + [x for x in smile(s, "c", F, T) if x[0] >= 0]
    return interp(sorted(otm), 0.0)


def guess(div):
    if div is None:
        return "不明"
    return "偏賣方" if div <= -IV_TH else "偏買方" if div >= IV_TH else "不明"


def build_view(snap, prev, ref):
    if not prev or "inst_opt" not in prev:
        return None
    d0, d1 = date.fromisoformat(prev["date"]), date.fromisoformat(snap["date"])
    # 三大法人買賣權分計（官方）
    inst = []
    for key, label in (("fi", "外資"), ("it", "投信"), ("dl", "自營商")):
        row = {"name": label}
        for cp in ("call", "put"):
            for bs in ("b", "s"):
                cur, old = snap["inst_opt"][key][cp], prev["inst_opt"][key][cp]
                row[f"{cp}_{bs}"] = cur[bs]
                row[f"{cp}_{bs}_d"] = cur[bs] - old[bs]
                row[f"{cp}_{bs}_amt"] = cur[bs + "_amt"]
        inst.append(row)
    series = []
    after = [(k, v) for k, v in snap["opt"].items() if v["exp"] > snap["date"].replace("-", "")]
    # 新掛牌的系列前一日沒有資料、算不出增減，跳過並往後補滿 OPT_SERIES 個
    for code, s in [kv for kv in sorted(after, key=lambda kv: kv[1]["exp"]) if kv[0] in prev["opt"]][:OPT_SERIES]:
        ps = prev["opt"][code]
        e = date(int(s["exp"][:4]), int(s["exp"][4:6]), int(s["exp"][6:8]))
        kind = "週選" if any(x in code[6:] for x in "WF") else "月選"
        F1, F0 = forward(snap, code), forward(prev, code)
        T1, T0 = trading_years(d1, e), trading_years(d0, e)
        # 同一履約價的隱含波動率比前一交易日下降＝權利金比理論上該有的便宜，推測賣方主導；上升推測買方主導。
        # 價平隱含波動率只當背景參考：整體波動率大跌的日子，多數價位都會被判為偏賣方
        atm1, atm0 = atm_iv(s, F1, T1), atm_iv(ps, F0, T0)
        atm_d = None if atm1 is None or atm0 is None else round((atm1 - atm0) * 100, 1)
        sides = {}
        for side in "cp":
            call = side == "c"
            rows = []
            for k, oi in s[side].items():
                K = int(k)
                dd = oi - ps[side].get(k, 0)
                if dd < BUILD_MIN or abs(K - ref) > ref * SR_RANGE:
                    continue
                p1, p0 = s["px"][side].get(k), ps["px"][side].get(k)
                iv1 = implied_vol(p1, F1, K, T1, call) if F1 else None
                iv0 = implied_vol(p0, F0, K, T0, call) if F0 else None
                div = None if iv1 is None or iv0 is None else round((iv1 - iv0) * 100, 1) + 0.0  # 避免 -0.0
                rows.append({"strike": K, "oi": oi, "d": dd, "vol": s["vol"][side].get(k, 0),
                             "px": p1, "px_d": None if p1 is None or p0 is None else round(p1 - p0, 1),
                             "iv": None if iv1 is None else round(iv1 * 100, 1), "iv_d": div, "guess": guess(div)})
            rows.sort(key=lambda x: -x["d"])
            sides[side] = rows[:BUILD_TOP]
        # 推測賣方佈局區間：指數以下偏賣方建倉最多的賣權 ～ 指數以上偏賣方建倉最多的買權
        sp = next((x for x in sides["p"] if x["strike"] <= ref and x["guess"] == "偏賣方"), None)
        sc = next((x for x in sides["c"] if x["strike"] >= ref and x["guess"] == "偏賣方"), None)
        series.append({"code": code, "exp": e.isoformat(), "label": f"{e.month}/{e.day}（{WEEKDAY[e.weekday()]}）{kind}",
                       "fwd": F1, "days": round(T1 * 252), "atm_iv": None if atm1 is None else round(atm1 * 100, 1), "atm_d": atm_d, "call": sides["c"], "put": sides["p"],
                       "range": {"put": sp, "call": sc},
                       "call_d": sum(s["c"].values()) - sum(ps["c"].values()), "put_d": sum(s["p"].values()) - sum(ps["p"].values())})
    return {"date": snap["date"], "prev_date": prev["date"], "ref": ref, "inst": inst, "series": series,
            "rule": {"min": BUILD_MIN, "top": BUILD_TOP, "iv_th": IV_TH, "min_premium": MIN_PREMIUM, "range": SR_RANGE}}
