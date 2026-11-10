"""個股查詢用的逐檔資料：每檔近 60 個交易日收盤價、近 10 個交易日三大法人買賣超（張）。

資料全部來自其他步驟已經抓好的快取，不另外連線：
  - 收盤價   data/quotes（證交所、櫃買中心每日行情，籌碼篩選與營收估值共用）
  - 法人     data/inst（證交所、櫃買中心三大法人買賣超日報）
只收普通股與 ETF。輸出 data/stock.json；前端只在打開「個股查詢」分頁時才載入。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "stock.json"
PRICE_DAYS = 60


def build(trade_date, days, price_dates, qall, quotes, is_etf, is_common_stock):
    """days：法人資料 [(日期, {代號: [外資, 投信, 自營商, 合計, 自營商自行買賣, 自營商避險]（股）})]，新→舊；
    price_dates／qall：交易日與每日行情 {代號: [收盤, 漲跌, 張數]}，新→舊，第一天是今天"""
    if not days or days[0][0] != trade_date:
        raise RuntimeError(f"法人資料日期 {days[0][0] if days else '-'} 與股票資料日期 {trade_date} 不一致")
    if not qall or price_dates[0] != trade_date:
        raise RuntimeError("沒有今天的歷史行情")
    pd = list(reversed(price_dates[:PRICE_DAYS]))
    qs = list(reversed(qall[:PRICE_DAYS]))
    ids = list(reversed(days))
    lots = lambda v: round(v / 1000)  # noqa: E731
    rows = {}
    for c, q in quotes.items():
        etf = is_etf(c)
        if not (etf or is_common_stock(c)):
            continue
        closes = [x[c][0] if c in x else None for x in qs]
        inst = [[lots(dd[c][i]) if c in dd else None for _, dd in ids] for i in (0, 1, 2)]
        rows[c] = [q["name"], q["market"], 1 if etf else 0, closes, *inst]
    return {
        "date": trade_date.isoformat(),
        "price_dates": [d.isoformat() for d in pd],
        "inst_dates": [d.isoformat() for d, _ in ids],
        "fields": ["名稱", "市場", "ETF", "收盤價", "外資", "投信", "自營商"],
        "rows": rows,
    }


def write(v):
    OUT.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
