#!/usr/bin/env python3
"""盤後資料更新：抓證交所(上市)與櫃買中心(上櫃)資料，產出 data/latest.json。

資料來源（皆為證交所公開資料）：
  - 每日收盤行情   www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL
  - 三大法人買賣超 www.twse.com.tw/rwd/zh/fund/T86
  - 已發行股數     openapi.twse.com.tw/v1/opendata/t187ap03_L（上市市值用）
  - 上櫃行情/法人  www.tpex.org.tw/www/zh-tw/afterTrading/otc、insti/dailyTrade

只用標準函式庫。法人每日資料會快取在 data/inst/，之後每天只需補抓新的一天。
"""
import csv
import gzip
import io
import json
import re
import sys
import time
import urllib.error
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

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip",
    "Referer": "https://www.twse.com.tw/zh/",
}


def get_text(url, retries=4):
    """回傳文字內容；HTTP 失敗或例外時重試，最後丟出含狀態碼與回應開頭的錯誤。"""
    last = None
    for i in range(retries):
        status, body = None, b""
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                status, body = r.status, r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
            return body.decode("utf-8-sig")
        except Exception as e:  # noqa: BLE001
            if isinstance(e, urllib.error.HTTPError):
                status, body = e.code, e.read()
            snippet = body[:200].decode("utf-8", "replace").replace("\n", " ")
            last = f"{type(e).__name__}: {e} | HTTP {status} | 回應開頭: {snippet!r}"
            print(f"[retry {i + 1}/{retries}] {url} -> {last}", file=sys.stderr)
            time.sleep(2 ** (i + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def get_json(url, retries=4):
    last = None
    for i in range(retries):
        try:
            text = get_text(url, retries=1)
            return json.loads(text)
        except (ValueError, RuntimeError) as e:
            last = str(e) if isinstance(e, RuntimeError) else f"{e} | 回應開頭: {text[:200]!r}"
            print(f"[retry {i + 1}/{retries}] {url} -> {last}", file=sys.stderr)
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
def parse_quote(code, name, close, chg_raw, shares, value, issued, market):
    close, shares = num(close), num(shares)
    if close is None or not shares:
        return None  # 當日無成交
    chg = num(chg_raw)
    if chg is None:
        chg = 0.0
    elif str(chg_raw).strip().startswith("-"):
        chg = -abs(chg)
    prev = close - chg
    return {
        "code": code, "name": name, "market": market,
        "close": close,
        "change": round(chg, 4),
        "pct": round(chg / prev * 100, 2) if prev else 0.0,
        "volume": round(shares / 1000),              # 張
        "value": num(value) or 0.0,                  # 元
        "issued": num(issued),                       # 已發行股數（上櫃行情內含）
    }


def parse_date(v):
    """'1151019'(民國) 或 '20261019' -> date"""
    v = str(v).strip().replace("/", "")
    if len(v) == 7:
        return date(int(v[:3]) + 1911, int(v[3:5]), int(v[5:7]))
    return datetime.strptime(v, "%Y%m%d").date()


def fetch_twse_quotes():
    # 這支 API 實際回傳 CSV（欄位：日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數）
    text = get_text("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=csv")
    rows = list(csv.reader(io.StringIO(text)))
    head = next((i for i, r in enumerate(rows) if "證券代號" in [c.strip() for c in r]), None)
    if head is None:
        raise RuntimeError(f"STOCK_DAY_ALL 找不到表頭，回應開頭: {text[:200]!r}")
    f = [c.strip() for c in rows[head]]
    ix = {k: f.index(k) for k in ["日期", "證券代號", "證券名稱", "成交股數", "成交金額", "收盤價", "漲跌價差"]}
    out, trade_date = {}, None
    for r in rows[head + 1:]:
        if len(r) < len(f) or not r[ix["證券代號"]].strip():
            continue
        trade_date = trade_date or parse_date(r[ix["日期"]])
        code = r[ix["證券代號"]].strip()
        q = parse_quote(code, r[ix["證券名稱"]].strip(), r[ix["收盤價"]], r[ix["漲跌價差"]],
                        r[ix["成交股數"]], r[ix["成交金額"]], None, "上市")
        if q:
            out[code] = q
    if not out or trade_date is None:
        raise RuntimeError("STOCK_DAY_ALL 解析不到任何行情")
    return trade_date, out


def tpex_table(url):
    """櫃買新版網站的 JSON：{'tables':[{'fields':[..],'data':[..]}]}；無資料回傳 None"""
    j = get_json(url)
    t = (j.get("tables") or [None])[0]
    if not t or not t.get("data"):
        return None
    return t


def fetch_tpex_quotes(d):
    t = tpex_table(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date={d:%Y/%m/%d}&type=EW&response=json")
    if t is None:
        raise RuntimeError(f"上櫃 {d} 行情無資料")
    f = [x.strip() for x in t["fields"]]

    def col(*keys):
        for i, x in enumerate(f):
            if any(x.startswith(k) for k in keys):
                return i
        raise RuntimeError(f"上櫃行情找不到欄位 {keys}；實際欄位：{f}")

    ic, inm, icl, ich = col("代號"), col("名稱"), col("收盤"), col("漲跌")
    ish, iva, iis = col("成交股數"), col("成交金額"), col("發行股數")
    out = {}
    for r in t["data"]:
        code = str(r[ic]).strip()
        q = parse_quote(code, str(r[inm]).strip(), r[icl], r[ich], r[ish], r[iva], r[iis], "上櫃")
        if q:
            out[code] = q
    return out


# ---------- 市值（上市股數） ----------
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


# ---------- 三大法人（外資 / 投信 / 自營商） ----------
# 每檔存 [外資, 投信, 自營商, 合計]（股）；寫入前檢查 外資+投信+自營商 == 合計
def check_sum(market, rows):
    bad = sum(1 for v in rows.values() if v[0] + v[1] + v[2] != v[3])
    if bad > max(3, len(rows) * 0.02):
        raise RuntimeError(f"{market} 法人欄位對不上：{bad}/{len(rows)} 檔 外資+投信+自營商≠合計，請檢查欄位定義")


def fetch_twse_inst(d):
    j = get_json(f"https://www.twse.com.tw/rwd/zh/fund/T86?date={d:%Y%m%d}&selectType=ALL&response=json")
    if j.get("stat") != "OK" or not j.get("data"):
        return None
    f = [x.strip() for x in j["fields"]]
    ci = f.index("證券代號")
    i_for = next(i for i, x in enumerate(f) if x.startswith("外陸資買賣超股數"))
    i_fd = next(i for i, x in enumerate(f) if x.startswith("外資自營商買賣超股數"))
    i_it, i_dl, i_all = f.index("投信買賣超股數"), f.index("自營商買賣超股數"), f.index("三大法人買賣超股數")
    out = {}
    for r in j["data"]:
        g = lambda i: int(num(r[i]) or 0)  # noqa: E731
        out[r[ci].strip()] = [g(i_for) + g(i_fd), g(i_it), g(i_dl), g(i_all)]
    check_sum("上市", out)
    return out


def fetch_tpex_inst(d):
    t = tpex_table(f"https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=AL&date={d:%Y/%m/%d}&id=&response=json")
    if t is None:
        return None
    f = t["fields"]
    if len(f) != 24:
        raise RuntimeError(f"上櫃法人欄位數 {len(f)}≠24（格式改版？）：{f}")
    # 0代號 1名稱 | 外資(不含自營)2-4 外資自營5-7 外資合計8-10 | 投信11-13 | 自營(自行)14-16 自營(避險)17-19 自營合計20-22 | 三大法人23
    out = {}
    for r in t["data"]:
        g = lambda i: int(num(r[i]) or 0)  # noqa: E731
        out[str(r[0]).strip()] = [g(10), g(13), g(22), g(23)]
    check_sum("上櫃", out)
    return out


def fetch_inst(d):
    tw = fetch_twse_inst(d)
    if tw is None:
        return None
    time.sleep(REQUEST_GAP)
    tp = fetch_tpex_inst(d)
    if tp is None:
        raise RuntimeError(f"上櫃 {d} 法人資料無資料，但上市有（可能尚未公布）")
    return {**tp, **tw}


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
            data = fetch_inst(d)
            if data is not None:
                p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                days.append((d, data))
            elif d == trade_date:
                raise RuntimeError(f"{d} 的三大法人資料尚未公布")
        d -= timedelta(days=1)
    keep = {f"{x:%Y%m%d}.json" for x, _ in days}
    for p in INST_DIR.glob("*.json"):
        if p.name not in keep and p.stem < f"{days[-1][0]:%Y%m%d}":
            p.unlink()
    return days


def inst_for(code, days):
    out = {"inst_days": len(days)}
    for i, key in enumerate(["fi", "it", "dl", "inst"]):  # 外資 / 投信 / 自營商 / 合計
        lots = lambda dd: round(dd.get(code, [0, 0, 0, 0])[i] / 1000)  # noqa: E731
        out[f"{key}_today"] = lots(days[0][1])
        out[f"{key}_prev"] = lots(days[1][1]) if len(days) > 1 else None
        out[f"{key}_10d"] = sum(lots(dd) for _, dd in days)
    return out


def build():
    trade_date, quotes = fetch_twse_quotes()
    time.sleep(REQUEST_GAP)
    quotes.update({c: q for c, q in fetch_tpex_quotes(trade_date).items() if c not in quotes})
    time.sleep(REQUEST_GAP)
    shares = fetch_issued_shares()
    for c, q in quotes.items():
        if q["market"] == "上市":
            q["issued"] = shares.get(c)
    days = load_inst_history(trade_date)
    if days[0][0] != trade_date:
        raise RuntimeError("法人資料日期與行情日期不一致")

    def enrich(q):
        q = {k: v for k, v in q.items() if k != "issued"}
        return {**q, **inst_for(q["code"], days)}

    # 權值股：市值 = 收盤價 × 已發行普通股數；占比以「該市場」全體普通股市值為分母
    caps = {c: q["close"] * q["issued"] for c, q in quotes.items() if q["issued"] and is_common_stock(c)}
    totals = {}
    for c, v in caps.items():
        totals[quotes[c]["market"]] = totals.get(quotes[c]["market"], 0) + v
    top_cap = sorted(caps, key=caps.get, reverse=True)[:TOP_CAP]
    cap_rows = [{**enrich(quotes[c]), "rank": i, "mktcap": round(caps[c] / 1e8),
                 "weight": round(caps[c] / totals[quotes[c]["market"]] * 100, 2)}
                for i, c in enumerate(top_cap, 1)]

    def top_by_volume(pred, n):
        cs = sorted((c for c in quotes if pred(c)), key=lambda c: quotes[c]["volume"], reverse=True)[:n]
        return [{**enrich(quotes[c]), "rank": i} for i, c in enumerate(cs, 1)]

    return {
        "date": trade_date.isoformat(),
        "updated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "inst_dates": [d.isoformat() for d, _ in days],
        "market": "上市＋上櫃",
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
        msg = f"{type(e).__name__}: {e}"
        print(f"ERROR: {msg}", file=sys.stderr)
        # GitHub Actions 註解：讓錯誤原因直接顯示在執行頁面的 Annotations
        print("::error title=fetch_data 失敗::" + msg[:1500].replace("%", "%25").replace("\r", "").replace("\n", "%0A"))
        sys.exit(1)
