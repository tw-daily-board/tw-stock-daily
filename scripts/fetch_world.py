"""國際市場（盤前速覽用）：美歐亞股市指數、美股期貨、債息匯率原物料、台積電 ADR 與相關美股的最近一次收盤。

資料來源（公開但非官方的網頁介面，使用者已同意；沒有免費又官方、程式可讀的來源）：
  - Yahoo Finance 圖表介面   query1.finance.yahoo.com/v8/finance/chart/<代號>?range=10d&interval=1d
  - Nasdaq.com 報價介面       api.nasdaq.com/api/quote/<代號>/info（只用在美股個股，Yahoo 抓不到時備援）
每個代號取最近兩根日 K：最後一根的收盤（期貨在交易時段中是最新成交價）與前一根比漲跌。
抓不到的項目留空並發警告，不用替代數字。
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "application/json"}
GAP = 0.6

# (分組, 代號, 名稱, 小數位)
MARKETS = [
    ("美股指數", "^DJI", "道瓊工業", 2), ("美股指數", "^GSPC", "S&P 500", 2), ("美股指數", "^IXIC", "那斯達克", 2),
    ("美股指數", "^SOX", "費城半導體", 2),
    ("美股期貨", "ES=F", "S&P 500 期貨", 2), ("美股期貨", "NQ=F", "那斯達克 100 期貨", 2),
    ("歐洲", "^GDAXI", "德國 DAX", 2), ("歐洲", "^FTSE", "英國 FTSE 100", 2), ("歐洲", "^FCHI", "法國 CAC 40", 2),
    ("亞洲", "^N225", "日經 225", 2), ("亞洲", "^KS11", "韓國 KOSPI", 2),
    ("其他", "^TNX", "美國 10 年期公債殖利率（%）", 3), ("其他", "DX-Y.NYB", "美元指數", 2), ("其他", "^VIX", "美股 VIX", 2),
    ("其他", "CL=F", "WTI 原油", 2), ("其他", "GC=F", "黃金", 1),
]
STOCKS = [
    ("AI／半導體", "NVDA", "輝達"), ("AI／半導體", "AMD", "AMD"), ("AI／半導體", "AVGO", "博通"), ("AI／半導體", "MU", "美光"),
    ("AI／半導體", "ASML", "艾司摩爾"), ("AI／半導體", "ARM", "安謀"),
    ("雲端／平台", "MSFT", "微軟"), ("雲端／平台", "GOOGL", "Google"), ("雲端／平台", "AMZN", "Amazon"), ("雲端／平台", "META", "Meta"),
    ("雲端／平台", "ORCL", "甲骨文"),
    ("消費電子／車", "AAPL", "蘋果"), ("消費電子／車", "TSLA", "特斯拉"), ("消費電子／車", "QCOM", "高通"),
]
ADR = ("TSM", "台積電 ADR")
ADR_RATIO = 5          # 1 股 ADR＝5 股台積電普通股


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {type(last).__name__}: {last}")


def yahoo(sym):
    j = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(sym)}?range=10d&interval=1d")
    res = ((j.get("chart") or {}).get("result") or [None])[0]
    if not res:
        raise RuntimeError(f"Yahoo {sym} 無資料：{(j.get('chart') or {}).get('error')}")
    meta, ts = res["meta"], res.get("timestamp") or []
    closes = (res.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
    bars = [(t, c) for t, c in zip(ts, closes) if c is not None]
    if len(bars) < 2:
        raise RuntimeError(f"Yahoo {sym} 日 K 不足")
    tz = timezone(timedelta(seconds=meta.get("gmtoffset", 0)))
    (t1, c1), (_, c0) = bars[-1], bars[-2]
    mt = meta.get("regularMarketTime") or t1
    reg = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    # 現在仍在該市場的正規交易時段內＝盤中價（還不是收盤）；期貨幾乎全天交易，一律標成最新成交價
    live = bool(reg) and reg.get("start", 0) <= time.time() < reg.get("end", 0)
    return {"close": c1, "prev": c0, "change": c1 - c0, "pct": (c1 / c0 - 1) * 100 if c0 else None, "live": live,
            "date": datetime.fromtimestamp(t1, tz).strftime("%Y-%m-%d"),
            "time": datetime.fromtimestamp(mt, timezone(timedelta(hours=8))).strftime("%m-%d %H:%M"), "src": "Yahoo"}


def nasdaq(sym):
    j = get(f"https://api.nasdaq.com/api/quote/{sym}/info?assetclass=stocks")
    p = ((j.get("data") or {}).get("primaryData")) or {}
    f = lambda s: float(str(s).replace("$", "").replace(",", "").replace("%", "").replace("+", ""))  # noqa: E731
    c, ch = f(p["lastSalePrice"]), f(p["netChange"])
    return {"close": c, "prev": c - ch, "change": ch, "pct": f(p["percentageChange"]), "live": (j.get("data") or {}).get("marketStatus") == "Open",
            "date": None, "time": p.get("lastTradeTimestamp", ""), "src": "Nasdaq"}


def rounded(x, d=2):
    return {**x, **{k: round(x[k], d) for k in ("close", "prev", "change") if x.get(k) is not None},
            "pct": round(x["pct"], 2) if x.get("pct") is not None else None}


def build(warn, tw_close_2330, usdtwd_fallback=None):
    """tw_close_2330：台積電台股最近收盤（算 ADR 溢價）；usdtwd_fallback：Yahoo 匯率抓不到時用期交所參考匯率"""
    markets, stocks, fails = [], [], []
    for grp, sym, name, d in MARKETS:
        time.sleep(GAP)
        try:
            markets.append({"group": grp, "sym": sym, "name": name, "dec": d, **rounded(yahoo(sym), d)})
        except Exception as e:  # noqa: BLE001
            fails.append(sym)
            markets.append({"group": grp, "sym": sym, "name": name, "dec": d, "close": None, "err": str(e)[:200]})
    adr = None
    for grp, sym, name in [("台積電 ADR", *ADR)] + STOCKS:
        time.sleep(GAP)
        row = {"group": grp, "sym": sym, "name": name}
        try:
            row.update(rounded(yahoo(sym)))
        except Exception as e:  # noqa: BLE001
            try:
                time.sleep(GAP)
                row.update(rounded(nasdaq(sym)))
            except Exception as e2:  # noqa: BLE001
                fails.append(sym)
                row.update({"close": None, "err": f"{str(e)[:120]}／{str(e2)[:120]}"})
        if sym == ADR[0]:
            adr = row
        else:
            stocks.append(row)
    # ADR 溢價：ADR 價格 × 美元兌台幣 ÷ 5，與台積電台股收盤比較
    fx, fx_src = None, None
    try:
        time.sleep(GAP)
        fx, fx_src = yahoo("TWD=X")["close"], "Yahoo 即時匯率"
    except Exception:  # noqa: BLE001
        if usdtwd_fallback:
            fx, fx_src = usdtwd_fallback, "期交所前一交易日參考匯率"
    if adr and adr.get("close") and fx and tw_close_2330:
        eq = adr["close"] * fx / ADR_RATIO
        adr.update({"fx": round(fx, 3), "fx_src": fx_src, "tw_close": tw_close_2330, "equiv": round(eq, 1),
                    "premium": round((eq / tw_close_2330 - 1) * 100, 2)})
    if fails:
        warn("國際市場部分項目未更新", RuntimeError("抓不到：" + "、".join(fails)))
    return {"markets": markets, "adr": adr, "stocks": stocks,
            "updated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")}


if __name__ == "__main__":
    print(json.dumps(build(lambda t, e: print(t, e, file=sys.stderr), 1500.0, 32.5), ensure_ascii=False, indent=1)[:3000])
