#!/usr/bin/env python3
"""盤後資料更新：抓證交所(上市)資料，產出 data/latest.json。

資料來源（皆為證交所公開資料）：
  - 每日收盤行情   www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL
  - 三大法人買賣超 www.twse.com.tw/rwd/zh/fund/T86
  - 已發行股數     openapi.twse.com.tw/v1/opendata/t187ap03_L（用來算市值）

只用標準函式庫。法人每日資料會快取在 data/inst/，之後每天只需補抓新的一天。
"""
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
INST_DIR = DATA / "inst"

TOP_CAP = 20      # 權值股數量
TOP_STOCK = 20    # 成交量前 N 大個股
TOP_ETF = 15      # 成交量前 N 大 ETF
INST_DAYS = 10    # 法人合計天數
REQUEST_GAP = 3.0  # 證交所會限流，請求之間間隔秒數

UA = {"User-Agent": "Mozilla/5.0 (tw-stock-daily)"}


def get_json(url, retries=4):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 ** (i + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def num(s):
    """'1,234.5' -> 1234.5；'--'、空值、'X0.00' -> None"""
    if s is None:
        return None
    s = str(s).replace(",", "").replace("+", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def is_etf(code):
    return code.startswith("00")


def is_common_stock(code):
    return bool(re.fullmatch(r"\d{4}", code)) and not is_etf(code)


# ---------- 行情 ----------
def fetch_quotes():
    j = get_json("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json")
    if j.get("stat") != "OK":
        raise RuntimeError(f"STOCK_DAY_ALL: {j.get('stat')}")
    trade_date = datetime.strptime(j["date"], "%Y%m%d").date()
    f = j["fields"]
    ix = {k: f.index(k) for k in ["證券代號", "證券名稱", "成交股數", "成交金額", "收盤價", "漲跌價差"]}
    quotes = {}
    for row in j["data"]:
        code = row[ix["證券代號"]].strip()
        close = num(row[ix["收盤價"]])
        shares = num(row[ix["成交股數"]])
        if close is None or not shares:
            continue  # 當日無成交
        chg_raw = str(row[ix["漲跌價差"]])
        chg = num(chg_raw)
        if chg is None:
            chg = 0.0
        elif chg_raw.strip().startswith("-"):
            chg = -abs(chg)
        prev = close - chg
        quotes[code] = {
            "code": code,
            "name": row[ix["證券名稱"]].strip(),
            "close": close,
            "change": round(chg, 4),
            "pct": round(chg / prev * 100, 2) if prev else 0.0,
            "volume": round(shares / 1000),                      # 張
            "value": num(row[ix["成交金額"]]) or 0.0,            # 元
        }
    return trade_date, quotes


# ---------- 市值 ----------
def fetch_issued_shares():
    j = get_json("https://openapi.twse.com.tw/v1/opendata/t187ap03_L")
    out = {}
    for r in j:
        code = r.get("公司代號", "").strip()
        key = next((k for k in r if "已發行普通股數" in k), None)
        v = num(r.get(key)) if key else None
        if code and v:
            out[code] = v
    if not out:
        raise RuntimeError("t187ap03_L: 找不到已發行股數欄位")
    return out


# ---------- 三大法人 ----------
def fetch_t86(d):
    """回傳 {code: 三大法人買賣超股數}；非交易日/尚未公布回傳 None"""
    url = (f"https://www.twse.com.tw/rwd/zh/fund/T86?date={d:%Y%m%d}"
           "&selectType=ALL&response=json")
    j = get_json(url)
    if j.get("stat") != "OK" or not j.get("data"):
        return None
    f = j["fields"]
    ci = f.index("證券代號")
    ni = f.index("三大法人買賣超股數")
    out = {}
    for row in j["data"]:
        v = num(row[ni])
        out[row[ci].strip()] = int(v) if v is not None else 0
    return out


def load_inst_history(trade_date):
    """取得 trade_date(含)往前最近 INST_DAYS 個交易日的法人資料，依日期新→舊。"""
    INST_DIR.mkdir(parents=True, exist_ok=True)
    days = []
    d = trade_date
    for _ in range(45):
        if len(days) >= INST_DAYS:
            break
        p = INST_DIR / f"{d:%Y%m%d}.json"
        if p.exists():
            days.append((d, json.loads(p.read_text())))
        elif d.weekday() < 5:
            time.sleep(REQUEST_GAP)
            data = fetch_t86(d)
            if data is not None:
                p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                days.append((d, data))
            elif d == trade_date:
                raise RuntimeError(f"{d} 的三大法人資料尚未公布")
        d -= timedelta(days=1)
    # 清掉太舊的快取
    keep = {f"{x:%Y%m%d}.json" for x, _ in days}
    for p in INST_DIR.glob("*.json"):
        if p.name not in keep and p.stem < f"{days[-1][0]:%Y%m%d}":
            p.unlink()
    return days


def inst_for(code, days):
    lots = lambda dd: round(dd.get(code, 0) / 1000)  # noqa: E731
    today = lots(days[0][1])
    prev = lots(days[1][1]) if len(days) > 1 else None
    total = sum(lots(dd) for _, dd in days)
    return {"inst_today": today, "inst_prev": prev, "inst_10d": total,
            "inst_days": len(days)}


def build():
    trade_date, quotes = fetch_quotes()
    time.sleep(REQUEST_GAP)
    shares = fetch_issued_shares()
    days = load_inst_history(trade_date)
    if days[0][0] != trade_date:
        raise RuntimeError("法人資料日期與行情日期不一致")

    def enrich(q):
        return {**q, **inst_for(q["code"], days)}

    # 權值股：市值 = 收盤價 × 已發行普通股數；占比以全體上市普通股為分母
    caps = {c: quotes[c]["close"] * shares[c] for c in quotes if c in shares and is_common_stock(c)}
    total_cap = sum(caps.values())
    top_cap = sorted(caps, key=caps.get, reverse=True)[:TOP_CAP]
    cap_rows = []
    for rank, c in enumerate(top_cap, 1):
        cap_rows.append({**enrich(quotes[c]), "rank": rank,
                         "mktcap": round(caps[c] / 1e8),  # 億元
                         "weight": round(caps[c] / total_cap * 100, 2)})

    def top_by_volume(pred, n):
        cs = sorted((c for c in quotes if pred(c)), key=lambda c: quotes[c]["volume"], reverse=True)[:n]
        return [{**enrich(quotes[c]), "rank": i} for i, c in enumerate(cs, 1)]

    return {
        "date": trade_date.isoformat(),
        "updated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "inst_dates": [d.isoformat() for d, _ in days],
        "market": "TWSE 上市",
        "cap": cap_rows,
        "stocks": top_by_volume(is_common_stock, TOP_STOCK),
        "etfs": top_by_volume(is_etf, TOP_ETF),
    }


def main():
    out = build()
    DATA.mkdir(exist_ok=True)
    (DATA / "latest.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"OK {out['date']}: cap={len(out['cap'])} stocks={len(out['stocks'])} etfs={len(out['etfs'])}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
