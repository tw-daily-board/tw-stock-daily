"""事件：上市櫃公司重大訊息、除權除息預告。

資料來源（皆為官方公開資料）：
  - 重大訊息   openapi.twse.com.tw/v1/opendata/t187ap04_L（上市）、www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O（上櫃）
               兩者都只提供最近一天，所以每次執行都抓，依發言日期累積在 data/news/YYYYMMDD.json，保留 NEWS_DAYS 天
  - 除權除息   www.twse.com.tw/rwd/zh/exRight/TWT48U（上市預告表）、www.tpex.org.tw/openapi/v1/tpex_exright_prepost（上櫃）
殖利率用最近一個交易日的收盤價（data/quotes 快取）計算。分類用主旨關鍵字比對，不用 LLM。
輸出 data/events.json。
"""
import json
import re
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEWS_DIR = ROOT / "data" / "news"
QUOTE_DIR = ROOT / "data" / "quotes"
OUT = ROOT / "data" / "events.json"
NEWS_DAYS = 10          # 重大訊息保留的日曆天數
DESC_MAX = 1200         # 說明最多保留幾個字（完整內容到公開資訊觀測站）
EXR_PAST_DAYS = 3       # 除權息表保留已過去幾天的（剛除完的也看得到）

# 主旨關鍵字分類：依序比對，先符合的為準
CATEGORIES = [
    ("澄清", r"澄清|媒體報導|報導之說明"),
    ("財報營收", r"財務報告|財報|自結|營收|營業收入|損益|盈餘(?!分配)|EPS"),
    ("股利", r"股利|配息|除權|除息|盈餘分配|收益分配"),
    ("庫藏股", r"庫藏股|買回本公司股份"),
    ("增減資", r"增資|減資|轉換公司債|可轉債|私募|發行新股|公司債|海外存託"),
    ("併購投資", r"合併|收購|公開收購|分割|取得|處分|投資|合資|讓與|受讓|背書保證|資金貸與"),
    ("法說會", r"法人說明會|法說會|業績發表"),
    ("人事董事會", r"董事|監察人|經理人|總經理|董事長|發言人|稽核|會計主管|財務主管|會計師|股東會|股東常會|股東臨時會"),
]


def category(subject):
    for name, pat in CATEGORIES:
        if re.search(pat, subject):
            return name
    return "其他"


def roc_date(s):
    """'1151024' 或 '115年10月24日' -> date"""
    m = re.fullmatch(r"(\d{2,3})年(\d{1,2})月(\d{1,2})日", s.strip())
    if m:
        y, mo, d = map(int, m.groups())
    else:
        s = s.strip()
        y, mo, d = int(s[:-4]), int(s[-4:-2]), int(s[-2:])
    return date(y + 1911, mo, d)


def hms(s):
    s = str(s).strip().zfill(6)
    return f"{s[:2]}:{s[2:4]}:{s[4:6]}"


def fnum(s):
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


# ---------- 重大訊息 ----------
def parse_news(rows, market):
    out = []
    for r in rows:
        r = {k.strip(): v for k, v in r.items()}
        subject = re.sub(r"\s+", " ", str(r.get("主旨", ""))).strip()
        code = str(r.get("公司代號") or r.get("SecuritiesCompanyCode") or "").strip()
        if not code or not subject:
            continue
        desc = str(r.get("說明", "")).replace("\r\n", "\n").strip()
        out.append({
            "d": roc_date(r["發言日期"]).isoformat(), "t": hms(r["發言時間"]), "code": code,
            "name": str(r.get("公司名稱") or r.get("CompanyName") or "").strip(), "market": market,
            "subject": subject, "cat": category(subject), "rule": str(r.get("符合條款", "")).strip(),
            "desc": desc[:DESC_MAX] + ("…（內容較長，完整說明請到公開資訊觀測站）" if len(desc) > DESC_MAX else ""),
        })
    return out


def load_news(get_json, today, gap):
    """抓最新一天的重大訊息並依發言日期併入快取；回傳保留期間內全部訊息（新→舊）"""
    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    fresh = parse_news(get_json("https://openapi.twse.com.tw/v1/opendata/t187ap04_L"), "上市")
    time.sleep(gap)
    fresh += parse_news(get_json("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O"), "上櫃")
    by_day = {}
    for x in fresh:
        by_day.setdefault(x["d"], []).append(x)
    for d, items in by_day.items():
        p = NEWS_DIR / f"{d.replace('-', '')}.json"
        old = json.loads(p.read_text()) if p.exists() else []
        seen = {(x["code"], x["t"], x["subject"]) for x in old}
        merged = old + [x for x in items if (x["code"], x["t"], x["subject"]) not in seen]
        p.write_text(json.dumps(merged, ensure_ascii=False, separators=(",", ":")))
    cutoff = f"{today - timedelta(days=NEWS_DAYS):%Y%m%d}"
    items = []
    for p in sorted(NEWS_DIR.glob("*.json")):
        if p.stem < cutoff:
            p.unlink()
            continue
        items += json.loads(p.read_text())
    items.sort(key=lambda x: (x["d"], x["t"], x["code"]), reverse=True)
    return items


# ---------- 除權除息 ----------
def latest_closes():
    files = sorted(QUOTE_DIR.glob("*.json"))
    if not files:
        return {}, None
    return {c: v[0] for c, v in json.loads(files[-1].read_text()).items()}, files[-1].stem


def load_exright(get_json, today, gap):
    rows = []
    j = get_json("https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json")
    if j.get("stat") != "OK":
        raise RuntimeError(f"證交所除權除息預告表抓不到：{j.get('stat')}")
    f = j["fields"]
    idt, ic, inm, ik, ist, ics = (f.index(k) for k in ("除權除息日期", "股票代號", "名稱", "除權息", "無償配股率", "現金股利"))
    for r in j["data"]:
        rows.append({"d": roc_date(r[idt]).isoformat(), "code": r[ic].strip(), "name": r[inm].strip(), "market": "上市",
                     "kind": r[ik].strip(), "cash": fnum(re.sub(r"<[^>]+>", "", r[ics])), "stock": fnum(r[ist])})
    time.sleep(gap)
    for r in get_json("https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost"):
        rows.append({"d": roc_date(r["ExRrightsExDividendDate"]).isoformat(), "code": r["SecuritiesCompanyCode"].strip(),
                     "name": r["CompanyName"].strip(), "market": "上櫃", "kind": r["ExRrightsExDividend"].replace("除", "").strip(),
                     "cash": fnum(r["CashDividend"]), "stock": fnum(r["StockDividendRatio"])})
    closes, qdate = latest_closes()
    start = (today - timedelta(days=EXR_PAST_DAYS)).isoformat()
    out = []
    for x in rows:
        if x["d"] < start:
            continue
        x["cash"] = x["cash"] or None          # 0＝尚未公告金額
        x["stock"] = x["stock"] or None
        x["close"] = closes.get(x["code"])
        x["yield"] = round(x["cash"] / x["close"] * 100, 2) if x["cash"] and x["close"] else None
        x["etf"] = not re.fullmatch(r"\d{4}", x["code"])   # 個股＝4 碼普通股；其餘（ETF、ETN、REITs）歸到 ETF
        out.append(x)
    out.sort(key=lambda x: (x["d"], x["code"]))
    return out, qdate


def build(get_json, today, gap):
    news = load_news(get_json, today, gap)
    time.sleep(gap)
    exr, qdate = load_exright(get_json, today, gap)
    return {
        "date": today.isoformat(), "news_days": NEWS_DAYS, "categories": [c for c, _ in CATEGORIES] + ["其他"],
        "news_dates": sorted({x["d"] for x in news}, reverse=True), "news": news,
        "exright": exr, "close_date": qdate and f"{qdate[:4]}-{qdate[4:6]}-{qdate[6:]}",
    }


def write(v):
    OUT.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
