"""市場整體強弱：漲跌家數（騰落）、成交金額與量比、類股漲跌與資金占比。

資料來源：
  - 上市漲跌家數   證交所 MI_INDEX?type=MS（漲跌證券數合計，取「股票」欄）
  - 上市類股指數   證交所 MI_INDEX?type=IND
  - 上市成交金額   證交所 FMTQIK（整月每日成交金額與加權指數）
  - 上櫃彙總       櫃買中心 afterTrading/highlight（漲跌家數、成交值、櫃買指數）
  - 類股成交金額   由上市個股行情依產業別加總（證交所 BFIAMU 常被擋，不用）
每日漲跌家數快取在 data/market/，第一次會回補，之後每天只抓新的一天。
"""
import json
import re
import time
from datetime import date, timedelta
from pathlib import Path

MARKET_DIR = Path(__file__).resolve().parent.parent / "data" / "market"
DAYS = 10

# 證交所產業別代碼（t187ap03_L「產業別」）；對應類股指數名稱「<名稱>類指數」
INDUSTRY = {
    "01": "水泥", "02": "食品", "03": "塑膠", "04": "紡織纖維", "05": "電機機械", "06": "電器電纜",
    "08": "玻璃陶瓷", "09": "造紙", "10": "鋼鐵", "11": "橡膠", "12": "汽車", "14": "建材營造",
    "15": "航運", "16": "觀光餐旅", "17": "金融保險", "18": "貿易百貨", "20": "其他", "21": "化學",
    "22": "生技醫療", "23": "油電燃氣", "24": "半導體", "25": "電腦及週邊設備", "26": "光電",
    "27": "通信網路", "28": "電子零組件", "29": "電子通路", "30": "資訊服務", "31": "其他電子",
    "35": "綠能環保", "36": "數位雲端", "37": "運動休閒", "38": "居家生活",
}


def fnum(s):
    try:
        return float(str(s).replace(",", "").replace("+", "").strip())
    except ValueError:
        return None


def updown(s):
    """'163(7)' -> (163, 7)"""
    m = re.match(r"\s*([\d,]+)\s*\((\d+)\)", str(s))
    return (int(m.group(1).replace(",", "")), int(m.group(2))) if m else (int(fnum(s) or 0), 0)


def fetch_day(get_json, d, gap):
    """單日上市／上櫃漲跌家數與上櫃成交值；沒資料（假日）回傳 None"""
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d:%Y%m%d}&type=MS&response=json")
    t = next((t for t in j.get("tables") or [] if (t.get("title") or "").startswith("漲跌證券數")), None)
    if j.get("stat") != "OK" or not t:
        return None
    rows = {r[0]: r[2] for r in t["data"]}            # 第 3 欄＝股票
    up, upl = updown(rows["上漲(漲停)"])
    dn, dnl = updown(rows["下跌(跌停)"])
    tw = {"up": up, "up_limit": upl, "down": dn, "down_limit": dnl, "flat": int(fnum(rows["持平"]) or 0)}
    time.sleep(gap)
    h = get_json(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/highlight?date={d:%Y/%m/%d}&response=json")
    ht = (h.get("tables") or [None])[0]
    if not ht or not ht.get("data"):
        raise RuntimeError(f"櫃買 {d} 彙總無資料（上市有）")
    r = dict(zip([f.strip() for f in ht["fields"]], ht["data"][0]))
    tp = {"up": int(fnum(r["上漲家數"])), "up_limit": int(fnum(r["漲停家數"])), "down": int(fnum(r["下跌家數"])),
          "down_limit": int(fnum(r["跌停家數"])), "flat": int(fnum(r["平盤家數"])),
          "value": round(fnum(r["本日總成交值(佰萬元)"]) / 100, 2),          # 佰萬元→億
          "index": fnum(r["收市指數"]), "change": fnum(r["指數漲跌"])}
    return {"date": d.isoformat(), "twse": tw, "tpex": tp}


def load_days(get_json, trade_date, gap):
    """trade_date（含）往前 DAYS 個交易日；快取在 data/market/"""
    MARKET_DIR.mkdir(parents=True, exist_ok=True)
    out, d = [], trade_date
    for _ in range(25):
        if len(out) >= DAYS:
            break
        p = MARKET_DIR / f"{d:%Y%m%d}.json"
        if p.exists():
            out.append(json.loads(p.read_text()))
        elif d.weekday() < 5:
            time.sleep(gap)
            rec = fetch_day(get_json, d, gap)
            if rec:
                p.write_text(json.dumps(rec, ensure_ascii=False))
                out.append(rec)
            elif d == trade_date:
                raise RuntimeError(f"{d} 漲跌家數尚未公布")
        d -= timedelta(days=1)
    for p in MARKET_DIR.glob("*.json"):
        if p.stem < out[-1]["date"].replace("-", ""):
            p.unlink()
    return out


def fetch_turnover(get_json, trade_date, gap):
    """上市每日成交金額（億）與加權指數；本月＋上月，足夠算 20 日均量"""
    rows = []
    first = trade_date.replace(day=1)
    for m in (first - timedelta(days=1), trade_date):
        time.sleep(gap)
        j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date={m:%Y%m}01&response=json")
        for r in j.get("data") or []:
            y, mo, dd = r[0].split("/")
            rows.append({"date": date(int(y) + 1911, int(mo), int(dd)).isoformat(),
                         "value": round(fnum(r[2]) / 1e8, 2), "index": fnum(r[4]), "change": fnum(r[5])})
    rows = [r for r in rows if r["date"] <= trade_date.isoformat()]
    if not rows or rows[-1]["date"] != trade_date.isoformat():
        raise RuntimeError(f"FMTQIK 尚無 {trade_date}")
    return rows


def fetch_sector_index(get_json, trade_date):
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={trade_date:%Y%m%d}&type=IND&response=json")
    t = next((t for t in j.get("tables") or [] if "價格指數(臺灣證券交易所)" in (t.get("title") or "")), None)
    if not t:
        raise RuntimeError("類股指數表找不到")
    out = {}
    for r in t["data"]:
        if r[0].endswith("類指數"):
            sign = -1 if "-" in re.sub(r"<[^>]+>", "", r[2]) and "green" in r[2] else 1
            out[r[0][:-3]] = round(sign * abs(fnum(r[4]) or 0), 2)
    return out


def build(get_json, trade_date, quotes, industry, gap=3.0):
    """quotes：上市＋上櫃個股行情（fetch_data 的格式）；industry：上市代號→產業別代碼"""
    days = load_days(get_json, trade_date, gap)
    turnover = fetch_turnover(get_json, trade_date, gap)
    time.sleep(gap)
    sidx = fetch_sector_index(get_json, trade_date)

    vals = [r["value"] for r in turnover]
    today = vals[-1]
    ratio = lambda n: round(today / (sum(vals[-n - 1:-1]) / n), 2) if len(vals) > n else None  # noqa: E731

    # 類股：成交金額依產業別加總（上市普通股）
    sec = {}
    for c, q in quotes.items():
        ind = industry.get(c)
        if q["market"] == "上市" and ind in INDUSTRY:
            sec.setdefault(INDUSTRY[ind], 0.0)
            sec[INDUSTRY[ind]] += q["value"]
    total = sum(sec.values()) or 1
    sectors = sorted(({"name": k, "value": round(v / 1e8, 2), "share": round(v / total * 100, 2), "pct": sidx.get(k)}
                      for k, v in sec.items()), key=lambda x: -x["value"])

    # 近 10 日：漲跌家數（上市＋上櫃）、騰落（上漲－下跌）與累計騰落線
    by_date = {r["date"]: r for r in turnover}
    trend, acc = [], 0
    for r in reversed(days):
        up = r["twse"]["up"] + r["tpex"]["up"]
        dn = r["twse"]["down"] + r["tpex"]["down"]
        acc += up - dn
        t = by_date.get(r["date"], {})
        trend.append({"date": r["date"], "index": t.get("index"), "change": t.get("change"),
                      "value": t.get("value"), "tpex_value": r["tpex"]["value"],
                      "up": up, "down": dn, "net": up - dn, "adl": acc})
    cur = days[0]
    return {
        "date": trade_date.isoformat(),
        "twse": {**cur["twse"], "index": turnover[-1]["index"], "change": turnover[-1]["change"], "value": today},
        "tpex": cur["tpex"],
        "ratio5": ratio(5), "ratio20": ratio(20),
        "trend": trend, "sectors": sectors,
    }
