"""籌碼補充：借券賣出餘額（每日）、千張大戶持股比例（每週）。

資料來源（皆為官方公開資料）：
  - 借券賣出   www.twse.com.tw/rwd/zh/marginTrading/TWT93U（上市）、www.tpex.org.tw/www/zh-tw/margin/sbl（上櫃）
               「融券借券賣出餘額」表，可指定日期；快取在 data/sbl/YYYYMMDD.json，保留 SBL_DAYS 個交易日
  - 集保分級   opendata.tdcc.com.tw/getOD.ashx?id=1-5（集保戶股權分散表，每週一次，只提供最新一週）
               快取在 data/tdcc/YYYYMMDD.json，保留 TDCC_WEEKS 週；週變化要累積兩週以上才算得出來
單位：股 -> 張（÷1000）。全部用固定規則整理，不用 LLM。輸出 data/sbl.json、data/holders.json。
"""
import csv
import io
import json
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SBL_DIR = ROOT / "data" / "sbl"
TDCC_DIR = ROOT / "data" / "tdcc"
INST_DIR = ROOT / "data" / "inst"
QUOTE_DIR = ROOT / "data" / "quotes"
SBL_OUT = ROOT / "data" / "sbl.json"
HOLDERS_OUT = ROOT / "data" / "holders.json"
SBL_DAYS = 6            # 今天＋前 5 個交易日（算 5 日增減）
TDCC_WEEKS = 13         # 約一季
TDCC_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"


class SblNotReady(RuntimeError):
    """當天借券賣出餘額尚未公布"""


def lots(s):
    try:
        return round(float(str(s).replace(",", "").strip()) / 1000)
    except ValueError:
        return None


# ---------- 借券賣出 ----------
# 兩個市場欄位順序相同：代號, 名稱, 融券(前日餘額, 賣出, 買進, 現券, 今日餘額, 限額), 借券賣出(前日餘額, 當日賣出, 當日還券, 當日調整, 當日餘額, 次一營業日限額), 備註
def parse_sbl(rows, market):
    out = {}
    for r in rows:
        bal = lots(r[12])
        if bal is None:
            continue
        out[str(r[0]).strip()] = [str(r[1]).strip(), market, bal, lots(r[9]), lots(r[10]), lots(r[6])]
    return out


def fetch_sbl(get_json, d, gap):
    """{代號: [名稱, 市場, 借券賣出餘額, 當日借券賣出, 當日還券, 融券餘額]}（張）；還沒公布回傳 None"""
    j = get_json(f"https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date={d:%Y%m%d}&response=json")
    if j.get("stat") != "OK" or j.get("date") != f"{d:%Y%m%d}" or not j.get("data"):
        return None
    out = parse_sbl(j["data"], "上市")
    time.sleep(gap)
    t = get_json(f"https://www.tpex.org.tw/www/zh-tw/margin/sbl?date={d:%Y/%m/%d}&response=json")
    tb = (t.get("tables") or [None])[0]
    if str(t.get("date")) != f"{d:%Y%m%d}" or not tb or not tb.get("data"):
        return None
    out.update(parse_sbl(tb["data"], "上櫃"))
    return out


def load_sbl(get_json, dates, gap):
    """dates：交易日清單（新→舊）；當天還沒公布丟 SblNotReady，以前缺的日子回補"""
    SBL_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for i, d in enumerate(dates[:SBL_DAYS]):
        p = SBL_DIR / f"{d:%Y%m%d}.json"
        if p.exists():
            out.append(json.loads(p.read_text()))
            continue
        time.sleep(gap)
        rec = fetch_sbl(get_json, d, gap)
        if not rec:
            if i == 0:
                raise SblNotReady(f"{d} 借券賣出餘額尚未公布")
            raise RuntimeError(f"{d} 借券賣出餘額抓不到")
        p.write_text(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
        out.append(rec)
    keep = {f"{d:%Y%m%d}.json" for d in dates[:SBL_DAYS]}
    for p in SBL_DIR.glob("*.json"):
        if p.name not in keep:
            p.unlink()
    return out


def read_day(dirpath, d):
    p = dirpath / f"{d:%Y%m%d}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def build_sbl(days, dates, is_common_stock):
    d0 = dates[0]
    q = read_day(QUOTE_DIR, d0)
    inst = read_day(INST_DIR, d0)
    rows = []
    for c, (name, market, bal, sell, ret, short) in days[0].items():
        if not (is_common_stock(c) or c.startswith("00")):
            continue
        prev = days[1].get(c) if len(days) > 1 else None
        old = days[-1].get(c) if len(days) == SBL_DAYS else None
        close, chg, vol = (q.get(c) or [None, None, None])
        if not bal and not sell and not (prev and prev[2]):
            continue
        rows.append({
            "code": c, "name": name, "market": market, "etf": c.startswith("00"),
            "close": close, "pct": round(chg / (close - chg) * 100, 2) if close and chg is not None and close - chg > 0 else None,
            "volume": vol, "bal": bal, "sell": sell, "ret": ret, "short": short,
            "d1": bal - prev[2] if prev else None, "d5": bal - old[2] if old else None,
            "sell_ratio": round(sell / vol * 100, 1) if vol and sell is not None else None,
            "fi": round(inst[c][0] / 1000) if c in inst else None,
        })
    return {"date": d0.isoformat(), "dates": [d.isoformat() for d in dates[:len(days)]], "rows": rows}


# ---------- 千張大戶（集保股權分散表） ----------
# 持股分級：1～15 依持股股數由小到大（12＝400,001～600,000 股、15＝1,000,001 股以上），16＝差異數調整，17＝合計
def fetch_tdcc(get_text):
    text = get_text(TDCC_URL)
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or rows[0][:3] != ["資料日期", "證券代號", "持股分級"]:
        raise RuntimeError(f"集保股權分散表格式不符：{rows[:1]}")
    out, ddate = {}, None
    for r in rows[1:]:
        if len(r) < 6:
            continue
        ddate = r[0]
        c, lv = r[1].strip(), int(r[2])
        x = out.setdefault(c, [0.0, 0, 0.0, 0])   # [千張以上%, 千張以上人數, 400 張以上%, 總人數]
        if lv == 15:
            x[0], x[1] = float(r[5]), int(r[3])
        if 12 <= lv <= 15:
            x[2] = round(x[2] + float(r[5]), 2)
        if lv == 17:
            x[3] = int(r[3])
    if not ddate:
        raise RuntimeError("集保股權分散表沒有資料")
    return date(int(ddate[:4]), int(ddate[4:6]), int(ddate[6:])), out


def load_tdcc(get_text, keep_code):
    """抓最新一週存快取（同一週不重複存），回傳 [(資料日期, {代號: [...]}), ...]（新→舊）"""
    TDCC_DIR.mkdir(parents=True, exist_ok=True)
    d, rec = fetch_tdcc(get_text)
    p = TDCC_DIR / f"{d:%Y%m%d}.json"
    if not p.exists():
        p.write_text(json.dumps({c: v for c, v in rec.items() if keep_code(c)}, separators=(",", ":")))
    files = sorted(TDCC_DIR.glob("*.json"), reverse=True)
    for f in files[TDCC_WEEKS:]:
        f.unlink()
    return [(date(int(f.stem[:4]), int(f.stem[4:6]), int(f.stem[6:])), json.loads(f.read_text())) for f in files[:TDCC_WEEKS]]


def build_holders(weeks, quotes, price_dates, qall, period_pct, is_common_stock):
    """weeks：[(日期, 資料)] 新→舊；quotes：今天行情（名稱、市場）；週漲跌用還原股價（集保資料日→今天）"""
    (d0, w0), w1, w4 = weeks[0], (weeks[1][1] if len(weeks) > 1 else None), (weeks[4][1] if len(weeks) > 4 else None)
    # 集保資料日到上一週資料日之間的交易日數（算這一週的股價漲跌）
    n_week = None
    if len(weeks) > 1 and qall and d0 in price_dates and weeks[1][0] in price_dates:
        n_week = price_dates.index(weeks[1][0]) - price_dates.index(d0)
    i0 = price_dates.index(d0) if d0 in price_dates else None
    rows = []
    for c, (r1000, p1000, r400, people) in w0.items():
        q = quotes.get(c)
        if not q or not people or not (is_common_stock(c) or c.startswith("00")):
            continue
        a = w1.get(c) if w1 else None
        b = w4.get(c) if w4 else None
        wk = period_pct(qall[i0:], c, n_week) if n_week and i0 is not None else None
        rows.append({
            "code": c, "name": q["name"], "market": q["market"], "etf": c.startswith("00"), "close": q["close"], "volume": q["volume"],
            "r1000": r1000, "p1000": p1000, "r400": r400, "people": people,
            "d1000": round(r1000 - a[0], 2) if a else None, "d400": round(r400 - a[2], 2) if a else None,
            "d1000_4w": round(r1000 - b[0], 2) if b else None,
            "dpeople": round((people / a[3] - 1) * 100, 2) if a and a[3] else None, "wk_pct": wk,
        })
    return {"date": d0.isoformat(), "prev": weeks[1][0].isoformat() if len(weeks) > 1 else None,
            "weeks": [d.isoformat() for d, _ in weeks], "rows": rows}


def write(path, v):
    path.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
