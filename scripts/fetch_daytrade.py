"""當沖觀察：當沖量與當沖比率、振幅、量能放大，並標示注意股、處置股、暫停先賣後買、非當沖標的。

盤後產生，給下一個交易日盤前參考；處置與暫停先賣後買都以「下一個交易日」判斷。
全部用固定規則整理，不用 LLM。資料來源：
  - 個股當沖量值   證交所 TWTB4U（rwd，可指定日期）、櫃買 intraday/stat?type=Daily
  - 注意股         證交所 announcement/notice、櫃買 bulletin/attention（當日）
  - 可能達處置     證交所 openapi announcement/notetrans、櫃買 openapi tpex_trading_warning_note
  - 處置股         證交所 openapi announcement/punish、櫃買 openapi tpex_disposal_information
  - 暫停先賣後買   當日註記（上面兩支當沖量值）＋預告表 證交所 openapi TWTBAU1、櫃買 openapi tpex_intraday_trading_pre
輸出 data/daytrade.json。
"""
import json
import re
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "daytrade.json"
MIN_VOL = 1000        # 列入排行的當日成交量下限（張）
MAX_ROWS = 300        # 依成交量取前幾名（加上有標記的股票）


def fnum(s):
    try:
        return float(str(s).replace(",", "").replace("%", "").strip())
    except ValueError:
        return None


def roc(s):
    """'1151022' 或 '115/10/22' -> date"""
    s = re.sub(r"\D", "", str(s))
    return date(int(s[:-4]) + 1911, int(s[-4:-2]), int(s[-2:]))


def periods(text):
    """'115/10/21～115/10/28'、'1151022~1151029' -> (起, 迄)"""
    parts = re.findall(r"\d{3}/?\d{2}/?\d{2}", str(text))
    return (roc(parts[0]), roc(parts[-1])) if parts else (None, None)


def next_trading_day(get_json, d):
    j = get_json("https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json")
    off = {r[0] for r in j.get("data") or [] if "開始交易" not in r[1] and "最後交易" not in r[1]}
    n = d + timedelta(days=1)
    while n.weekday() >= 5 or n.isoformat() in off:
        n += timedelta(days=1)
    return n


# ---------- 當沖量值 ----------
def dt_table(tables, d, market, min_rows):
    stat = next((t for t in tables if "統計資訊" in (t.get("subtitle") or t.get("title") or "") and len(t.get("data") or []) == 1), None)
    lst = next((t for t in tables if "標的及成交量值" in (t.get("subtitle") or t.get("title") or "")), None)
    if not stat or not lst or len(lst.get("data") or []) < min_rows:
        raise RuntimeError(f"{market} {d} 當沖統計尚未公布或格式改版")
    f = [x.strip() for x in lst["fields"]]
    ic, isu, ish = f.index("證券代號"), f.index("暫停現股賣出後現款買進當沖註記"), f.index("當日沖銷交易成交股數")
    rows = {str(r[ic]).strip(): {"dt_shares": int(fnum(r[ish]) or 0), "suspend": bool(str(r[isu]).strip())} for r in lst["data"]}
    s = stat["data"][0]
    return rows, {"ratio_vol": fnum(s[1]), "ratio_buy": fnum(s[3]), "shares": int(fnum(s[0]))}


def fetch_dt(get_json, d, gap):
    j = get_json(f"https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U?date={d:%Y%m%d}&selectType=All&response=json")
    if j.get("stat") != "OK" or j.get("date") != f"{d:%Y%m%d}":
        raise RuntimeError(f"證交所 {d} 當沖統計尚未公布")
    tw, tw_stat = dt_table(j["tables"], d, "上市", 800)
    time.sleep(gap)
    t = get_json(f"https://www.tpex.org.tw/www/zh-tw/intraday/stat?type=Daily&date={d:%Y/%m/%d}&id=&response=json")
    if str(t.get("date")) != f"{d:%Y%m%d}":
        raise RuntimeError(f"櫃買 {d} 當沖統計尚未公布")
    tp, tp_stat = dt_table(t["tables"], d, "上櫃", 500)
    return {**tp, **tw}, {"上市": tw_stat, "上櫃": tp_stat}


# ---------- 注意、處置、暫停先賣後買 ----------
def fetch_flags(get_json, d, nd, gap):
    """回傳 {代號: [(類型, 說明), ...]}；類型：注意、可能處置、處置、暫停先賣後買"""
    flags = {}

    def add(code, kind, text):
        flags.setdefault(str(code).strip(), []).append((kind, re.sub(r"<[^>]+>", " ", str(text)).strip()))

    j = get_json(f"https://www.twse.com.tw/rwd/zh/announcement/notice?querytype=1&stockNo=&selectType=&startDate={d:%Y%m%d}&endDate={d:%Y%m%d}&sortKind=STKNO&response=json")
    if j.get("stat") != "OK":
        raise RuntimeError("證交所注意股抓不到")
    f = j["fields"]
    for r in j.get("data") or []:
        add(r[f.index("證券代號")], "注意", r[f.index("注意交易資訊")])
    time.sleep(gap)
    t = get_json(f"https://www.tpex.org.tw/www/zh-tw/bulletin/attention?date={d:%Y/%m/%d}&code=&response=json")
    tb = (t.get("tables") or [{}])[0]
    if str(t.get("stat")).lower() != "ok":
        raise RuntimeError("櫃買注意股抓不到")
    f = [x.strip() for x in tb.get("fields") or []]
    for r in tb.get("data") or []:
        add(r[f.index("證券代號")], "注意", r[f.index("注意交易資訊")])

    def openapi(url):
        time.sleep(gap)
        v = get_json(url)
        if not isinstance(v, list):
            raise RuntimeError(f"{url} 格式不對")
        return v

    for r in openapi("https://openapi.twse.com.tw/v1/announcement/notetrans"):
        add(r["Code"], "可能處置", r.get("RecentlyMetAttentionSecuritiesCriteria", ""))
    for r in openapi("https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_note"):
        code = r.get("SecuritiesCompanyCode") or r.get("Code")
        if code:
            add(code, "可能處置", next((v for k, v in r.items() if k not in ("Date", "SecuritiesCompanyCode", "CompanyName", "Code", "Name")), ""))
    for r in openapi("https://openapi.twse.com.tw/v1/announcement/punish"):
        a, b = periods(r.get("DispositionPeriod"))
        if a and a <= nd <= b:
            add(r["Code"], "處置", f"{r.get('DispositionMeasures', '')}（{r.get('DispositionPeriod')}）")
    for r in openapi("https://www.tpex.org.tw/openapi/v1/tpex_disposal_information"):
        a, b = periods(r.get("DispositionPeriod"))
        if a and a <= nd <= b:
            add(r["SecuritiesCompanyCode"], "處置", f"{r.get('DispositionReasons', '')}（{a:%m/%d}～{b:%m/%d}）")
    for r in openapi("https://openapi.twse.com.tw/v1/exchangeReport/TWTBAU1"):
        a, b = roc(r["StartDate"]), roc(r["EndDate"])
        if a <= nd <= b:
            add(r["Code"], "暫停先賣後買", f"{r.get('Reason', '')}（{a:%m/%d}～{b:%m/%d}）")
    for r in openapi("https://www.tpex.org.tw/openapi/v1/tpex_intraday_trading_pre"):
        a, back = roc(r["FirstDayToSuspendSellThenBuy"]), roc(r["DayOfReinstatingSellThenBuy"])
        if a <= nd < back:
            add(r["SecuritiesCompanyCode"], "暫停先賣後買", f"{r.get('Reason', '')}（{a:%m/%d} 起，{back:%m/%d} 恢復）")
    return flags


# ---------- 組表 ----------
def build(get_json, trade_date, quotes, qall, is_etf, is_common_stock, gap=3.0):
    nd = next_trading_day(get_json, trade_date)
    time.sleep(gap)
    dt, stats = fetch_dt(get_json, trade_date, gap)
    time.sleep(gap)
    flags = fetch_flags(get_json, trade_date, nd, gap)

    pool = [c for c, q in quotes.items() if is_etf(c) or is_common_stock(c)]
    by_vol = sorted((c for c in pool if quotes[c]["volume"] >= MIN_VOL), key=lambda c: -quotes[c]["volume"])[:MAX_ROWS]
    codes = list(dict.fromkeys(by_vol + [c for c in pool if c in flags]))
    rows = []
    for c in codes:
        q = quotes[c]
        prev = q["close"] - q["change"]
        vols = [qd[c][2] for qd in (qall or [])[1:21] if c in qd]
        avg20 = sum(vols) / len(vols) if len(vols) >= 10 else None
        d = dt.get(c)
        fl = list(flags.get(c, []))
        if d and d["suspend"]:
            fl.append(("暫停先賣後買", "今日註記暫停現股先賣後買當沖"))
        if not d:
            fl.append(("非當沖標的", "不在今日現股當沖標的清單"))
        kinds = []
        for k, _ in fl:
            if k not in kinds:
                kinds.append(k)
        rows.append({
            "code": c, "name": q["name"], "market": q["market"], "etf": is_etf(c),
            "close": q["close"], "pct": q["pct"], "volume": q["volume"],
            "amp": round((q["high"] - q["low"]) / prev * 100, 2) if q.get("high") and q.get("low") and prev > 0 else None,
            "vol_ratio": round(q["volume"] / avg20, 2) if avg20 else None,
            "dt": round(d["dt_shares"] / 1000) if d else None,
            "dt_ratio": round(d["dt_shares"] / 1000 / q["volume"] * 100, 1) if d and q["volume"] else None,
            "flags": kinds, "flag_text": [f"{k}：{t}" for k, t in fl if t],
        })
    rows.sort(key=lambda r: -r["volume"])
    return {"date": trade_date.isoformat(), "next_day": nd.isoformat(), "market": stats,
            "rules": {"min_vol": MIN_VOL, "max_rows": MAX_ROWS}, "rows": rows}


def write(v):
    OUT.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
