"""趨勢：近 60 個交易日的大盤、外資、融資、漲跌家數、期貨籌碼與 P/C 比（給「趨勢」分頁畫圖）。

資料來源（皆為官方公開資料，可指定日期，所以能直接回補，不用等累積）：
  - 加權指數、成交金額   證交所 FMTQIK（fetch_data 已抓 4 個月，直接沿用）
  - 外資現貨買賣超（上市）、融資餘額（上市＋上櫃）  證交所 BFI82U、MI_MARGN、櫃買 margin/balance（與綜合訊號同一套 fetch_signals.fetch_chips）
  - 漲跌家數（上市＋上櫃）  證交所 MI_INDEX MS、櫃買 highlight（與市場強弱同一套 fetch_market.fetch_day）
  - 外資台指期淨未平倉、小台／微台散戶多空比  期交所 futContractsDateDown（可查 3 個月）、futDataDown（一次最多約一個月，分段查）
  - P/C 比  期交所 pcRatioDown
  - 台指 VIX  期交所「臺指選擇權波動率指數」每月檔（每日收盤值，可下載前 3 個月）
  - 20 日歷史波動率  由加權指數每日漲跌自己算：近 20 日對數報酬的標準差 × √252（年化 %）
每日的現貨資料先讀 data/chips/、data/market/ 快取，沒有才回補，結果存在 data/trend/YYYYMMDD.json（保留 TREND_DAYS 天）；
期交所的資料每次用區間查詢重抓（約 13 次請求）。當天還沒公布的項目留空，不用替代數字。輸出 data/trend.json。
"""
import json
import math
import statistics
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import fetch_fut

ROOT = Path(__file__).resolve().parent.parent
TREND_DIR = ROOT / "data" / "trend"
CHIPS_DIR = ROOT / "data" / "chips"
MARKET_DIR = ROOT / "data" / "market"
OUT = ROOT / "data" / "trend.json"
TREND_DAYS = 60
MAX_FETCH_PER_RUN = 30     # 每次最多回補幾天的現貨資料（第一次回補分批也沒關係）
RETAIL = [("MTX", "小型臺指期貨"), ("TMF", "微型臺指期貨")]
VIX_URL = "https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/{ym}new.txt"
HV_DAYS = 20


def read(dirpath, d):
    p = dirpath / f"{d:%Y%m%d}.json"
    return json.loads(p.read_text()) if p.exists() else None


# ---------- 現貨（每日快取） ----------
def day_record(chips, mkt):
    m = chips["margin"]
    return {"fi": chips["inst"]["fi"], "fin_amt": round(m["twse"]["fin_amt"] + m["tpex"]["fin_amt"], 2),
            "up": mkt["twse"]["up"] + mkt["tpex"]["up"], "down": mkt["twse"]["down"] + mkt["tpex"]["down"]}


def load_spot(get_json, dates, today, gap, warn):
    """dates：交易日（新→舊）。今天的資料只讀快取（還沒公布就留空），以前的沒有就回補"""
    import fetch_market
    import fetch_signals
    TREND_DIR.mkdir(parents=True, exist_ok=True)
    out, fetched = {}, 0
    for d in dates:
        rec = read(TREND_DIR, d)
        if rec is None:
            chips, mkt = read(CHIPS_DIR, d), read(MARKET_DIR, d)
            if (chips is None or mkt is None) and d != today and fetched < MAX_FETCH_PER_RUN:
                try:
                    fetched += 1
                    if chips is None:
                        time.sleep(gap)
                        chips = fetch_signals.fetch_chips(get_json, d, gap)
                    if mkt is None:
                        time.sleep(gap)
                        mkt = fetch_market.fetch_day(get_json, d, gap)
                    if chips is None or mkt is None:
                        raise RuntimeError("證交所沒有這天的資料")
                except Exception as e:  # noqa: BLE001
                    warn(f"趨勢 {d} 現貨資料未回補（下次排程再補）", e)
                    time.sleep(30)  # 證交所限流時先停一下
                    chips = mkt = None
            if chips and mkt:
                rec = day_record(chips, mkt)
                (TREND_DIR / f"{d:%Y%m%d}.json").write_text(json.dumps(rec))
        out[d.isoformat()] = rec
    keep = {f"{d:%Y%m%d}.json" for d in dates}
    for p in TREND_DIR.glob("*.json"):
        if p.name not in keep:
            p.unlink()
    return out


# ---------- 期交所（區間查詢） ----------
def csv_rows(path, params):
    """期交所 CSV；查詢區間超過上限時會回傳 HTML 錯誤頁，這時報錯而不是當成沒資料"""
    rows = fetch_fut.get_csv(path, params)
    if rows and any(str(k).lstrip().startswith("<") for k in rows[0]):
        raise RuntimeError(f"期交所 {path} 回傳錯誤頁（查詢區間可能太長）：{params}")
    return [fetch_fut.clean(r) for r in rows]


def windows(start, end, days=28):
    """切成每段最多 days 天（futDataDown、pcRatioDown 一次最多約一個月）"""
    s = start
    while s <= end:
        e = min(s + timedelta(days=days - 1), end)
        yield s, e
        s = e + timedelta(days=1)


def fut_range(start, end):
    """{日期: {"fi_oi": 外資台指期淨未平倉, "MTX"/"TMF": 散戶多空比%}}"""
    q = f"queryStartDate={start:%Y/%m/%d}&queryEndDate={end:%Y/%m/%d}"
    inst = {}
    for r in csv_rows("futContractsDateDown", q):
        if not r.get("日期"):
            continue
        x = inst.setdefault(r["日期"].replace("/", "-"), {})
        if r["商品名稱"] == "臺股期貨" and r["身份別"] == "外資及陸資":
            x["fi_oi"] = int(fetch_fut.fnum(r["多空未平倉口數淨額"]))
        for code, name in RETAIL:
            if r["商品名稱"] == name and r["身份別"] in fetch_fut.INST_NAMES:
                y = x.setdefault(code, {"L": 0, "S": 0, "n": 0})
                y["L"] += int(fetch_fut.fnum(r["多方未平倉口數"]))
                y["S"] += int(fetch_fut.fnum(r["空方未平倉口數"]))
                y["n"] += 1
    # 全市場未平倉＝一般盤所有月份＋週契約（不含價差單），與 fetch_fut.parse_quotes 相同；futDataDown 一次最多查約一個月
    oi = {}
    for code, _ in RETAIL:
        for s, e in windows(start, end):
            time.sleep(1)
            for r in csv_rows("futDataDown", f"down_type=1&commodity_id={code}&commodity_id2=&queryStartDate={s:%Y/%m/%d}&queryEndDate={e:%Y/%m/%d}"):
                if r.get("契約") == code and r.get("交易時段") == "一般" and "/" not in r.get("到期月份(週別)", "/"):
                    k = (r["交易日期"].replace("/", "-"), code)
                    oi[k] = oi.get(k, 0) + int(fetch_fut.fnum(r["未沖銷契約數"]) or 0)
    out = {}
    for d, x in inst.items():
        o = {"fi_oi": x.get("fi_oi")}
        for code, _ in RETAIL:
            y, t = x.get(code), oi.get((d, code))
            o[code] = round((y["S"] - y["L"]) / t * 100, 2) if y and y["n"] == 3 and t else None
        out[d] = o
    return out


def pc_range(start, end):
    out = {}
    for s, e in windows(start, end):
        time.sleep(1)
        for r in csv_rows("pcRatioDown", f"queryStartDate={s:%Y/%m/%d}&queryEndDate={e:%Y/%m/%d}"):
            if r.get("日期"):
                out[r["日期"].replace("/", "-")] = {"pc_oi": fetch_fut.fnum(r["買賣權未平倉量比率%"]), "pc_vol": fetch_fut.fnum(r["買賣權成交量比率%"])}
    return out


# ---------- 波動率 ----------
def vix_month(ym):
    """{日期: 收盤 VIX}；檔案為 Big5 文字檔：交易日期、時間、指數、收盤前 1 分鐘平均（以 tab 分隔）"""
    last = None
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(VIX_URL.format(ym=ym), headers=fetch_fut.UA), timeout=40) as r:
                text = r.read().decode("cp950", "replace")
            break
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 ** (i + 1))
    else:
        raise RuntimeError(f"期交所 VIX {ym} 抓不到：{last}")
    if "臺指選擇權波動率指數" not in text:
        raise RuntimeError(f"期交所 VIX {ym} 格式不符：{text[:80]!r}")
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) >= 3 and f[0].isdigit() and len(f[0]) == 8:
            out[f"{f[0][:4]}-{f[0][4:6]}-{f[0][6:]}"] = float(f[2])
    return out


def vix_range(start, end):
    out, m = {}, start.replace(day=1)
    while m <= end:
        time.sleep(1)
        out.update(vix_month(f"{m:%Y%m}"))
        m = (m + timedelta(days=32)).replace(day=1)
    return out


def hv(turnover, i, n=HV_DAYS):
    """turnover 第 i 天（含）往前 n 天的年化歷史波動率（%）；漲跌來自 FMTQIK（參考價＝收盤－漲跌）"""
    if i + 1 < n:
        return None
    rets = []
    for r in turnover[i - n + 1:i + 1]:
        if r["index"] is None or r["change"] is None or r["index"] - r["change"] <= 0:
            return None
        rets.append(math.log(r["index"] / (r["index"] - r["change"])))
    return round(statistics.stdev(rets) * math.sqrt(252) * 100, 2)


def build(get_json, turnover, today, gap, warn):
    """turnover：FMTQIK（舊→新，含加權指數）；也是交易日清單"""
    tv = turnover[-TREND_DAYS:]
    dates = [date.fromisoformat(r["date"]) for r in reversed(tv)]
    spot = load_spot(get_json, dates, date.fromisoformat(tv[-1]["date"]) if tv[-1]["date"] == today.isoformat() else None, gap, warn)
    fut, pc = {}, {}
    try:
        fut = fut_range(dates[-1], dates[0])
        pc = pc_range(dates[-1], dates[0])
    except Exception as e:  # noqa: BLE001
        warn("趨勢期貨資料未更新", e)
    vix = {}
    try:
        vix = vix_range(dates[-1], dates[0])
    except Exception as e:  # noqa: BLE001
        warn("台指 VIX 未更新", e)
    off = len(turnover) - len(tv)
    rows, adl = [], 0
    for j, r in enumerate(tv):
        s = spot.get(r["date"]) or {}
        net = s["up"] - s["down"] if s else None
        adl = adl + net if net is not None else adl
        rows.append({"date": r["date"], "index": r["index"], "change": r["change"], "value": r["value"],
                     "fi": s.get("fi"), "fin_amt": s.get("fin_amt"), "up": s.get("up"), "down": s.get("down"),
                     "net": net, "adl": adl if net is not None else None,
                     **{k: (fut.get(r["date"]) or {}).get(k) for k in ("fi_oi", "MTX", "TMF")},
                     **{k: (pc.get(r["date"]) or {}).get(k) for k in ("pc_oi", "pc_vol")},
                     "vix": vix.get(r["date"]), "hv20": hv(turnover, off + j)})
    return {"date": tv[-1]["date"], "days": len(rows), "rows": rows}


def write(v):
    OUT.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
