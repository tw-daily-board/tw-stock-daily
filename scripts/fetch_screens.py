"""籌碼篩選：連買連賣、籌碼背離（買不漲／賣不跌）、隔日沖（一天買隔天賣／一天賣隔天買）。

全部用固定規則從已抓的資料計算，不用 LLM：
  - 法人：data/inst/（fetch_data 的快取，每檔 [外資, 投信, 自營商, 合計, 自營自行, 自營避險]，股）
  - 行情：data/quotes/（本檔維護，每檔 [收盤, 漲跌, 成交張數]）；當天直接用 fetch_data 抓到的行情，
          以前的交易日用證交所 MI_INDEX 與櫃買 otc 依日期回補
輸出 data/screens.json（籌碼篩選分頁讀這個檔）。
"""
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUOTE_DIR = ROOT / "data" / "quotes"
OUT = ROOT / "data" / "screens.json"

# 法人類別：(代碼, 名稱, 在 inst 快取中的位置)
CATS = [("fi", "外資", 0), ("it", "投信", 1), ("dls", "自營商（自行買賣）", 4), ("dlh", "自營商（避險）", 5)]
MIN_VOL = 1000        # 流動性：當日成交量至少這麼多張
STREAK_MIN = 3        # 連買連賣至少幾天（網頁可再篩 5 天）
DIVERGE_DAYS = 3      # 背離看近幾日
DIVERGE_LOTS = 1000   # 背離：近 N 日累計買賣超至少幾張
FLIP_LOTS = 1000      # 隔日沖：前一日買（賣）超至少幾張
FLIP_RATIO = 0.7      # 隔日沖：今天反向至少達前一日的幾成
MAX_ROWS = 150        # 每張表最多幾檔（依張數排序）


def fnum(s):
    try:
        return float(str(s).replace(",", "").replace("+", "").strip())
    except ValueError:
        return None


# ---------- 每日行情快取 ----------
def fetch_twse_day(get_json, d):
    """證交所某日全部個股與 ETF 行情 {代號: [收盤, 漲跌, 成交張數]}；假日回傳 None"""
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d:%Y%m%d}&type=ALLBUT0999&response=json")
    if j.get("stat") != "OK":
        return None
    t = next((t for t in j.get("tables") or [] if "證券代號" in (t.get("fields") or []) and "收盤價" in t["fields"]), None)
    if not t:
        return None
    f = t["fields"]
    ic, icl, isg, idf, ivol = (f.index(k) for k in ("證券代號", "收盤價", "漲跌(+/-)", "漲跌價差", "成交股數"))
    out = {}
    for r in t["data"]:
        close, diff, vol = fnum(r[icl]), fnum(r[idf]), fnum(r[ivol])
        if close is None or not vol:
            continue
        sign = re.sub(r"<[^>]+>", "", r[isg]).strip()
        chg = -abs(diff) if sign == "-" else abs(diff) if sign == "+" else (0.0 if diff == 0 else None)  # X＝除權息等，方向不明
        out[r[ic].strip()] = [close, chg, round(vol / 1000)]
    return out


def from_quotes(quotes):
    return {c: [q["close"], q["change"], q["volume"]] for c, q in quotes.items()}


def load_quotes(get_json, fetch_tpex_quotes, inst_days, quotes_today, gap):
    """依法人快取的交易日（新→舊）取得每日行情；回傳 list，順序與 inst_days 相同"""
    QUOTE_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for i, (d, _) in enumerate(inst_days):
        p = QUOTE_DIR / f"{d:%Y%m%d}.json"
        if i == 0:
            q = from_quotes(quotes_today)   # 當天用最新抓到的行情（20:57 那輪會是修正後的數字）
        elif p.exists():
            q = json.loads(p.read_text())
        else:
            time.sleep(gap)
            q = fetch_twse_day(get_json, d)
            if not q:
                raise RuntimeError(f"證交所 {d} 個股行情抓不到（法人有資料）")
            time.sleep(gap)
            q.update({c: v for c, v in from_quotes(fetch_tpex_quotes(d)).items() if c not in q})
        p.write_text(json.dumps(q, ensure_ascii=False, separators=(",", ":")))
        out.append(q)
    keep = {f"{d:%Y%m%d}.json" for d, _ in inst_days}
    for p in QUOTE_DIR.glob("*.json"):
        if p.name not in keep:
            p.unlink()
    return out


# ---------- 規則 ----------
def period_pct(qdays, code, n):
    """近 n 個交易日（含今天）的漲跌幅%：今天收盤 vs 第 n 天前一日的收盤"""
    if len(qdays) < n or any(code not in q for q in qdays[:n]):
        return None
    close = qdays[0][code][0]
    first_close, first_chg = qdays[n - 1][code][0], qdays[n - 1][code][1]
    if first_chg is not None:
        base = first_close - first_chg
    elif len(qdays) > n and code in qdays[n]:
        base = qdays[n][code][0]
    else:
        return None
    return round((close / base - 1) * 100, 2) if base else None


def streak(lots):
    """lots 新→舊；|張數|≥1 的同方向連續天數，帶正負號"""
    if not lots or abs(lots[0]) < 1:
        return 0
    s = 1 if lots[0] > 0 else -1
    n = 0
    for v in lots:
        if v * s >= 1:
            n += 1
        else:
            break
    return n * s


def build(inst_days, qdays, quotes, is_etf, is_common_stock, trade_date):
    def base(code, q):
        return {"code": code, "name": q["name"], "market": q["market"], "close": q["close"],
                "pct": q["pct"], "volume": q["volume"]}

    pool = {c: q for c, q in quotes.items()
            if q["volume"] >= MIN_VOL and (is_etf(c) or is_common_stock(c)) and c in inst_days[0][1]}

    def lots_of(code, idx):
        return [round(dd.get(code, [0] * 6)[idx] / 1000) for _, dd in inst_days]

    streaks, diverge, flips = {}, {}, {}
    for key, _, idx in CATS:
        st, fl = [], []
        for c, q in pool.items():
            lots = lots_of(c, idx)
            n = streak(lots)
            if abs(n) >= STREAK_MIN:
                st.append({**base(c, q), "etf": is_etf(c), "days": n, "cum": sum(lots[:abs(n)]),
                           "today": lots[0], "ppct": period_pct(qdays, c, abs(n))})
            if len(lots) > 1:
                prev, today = lots[1], lots[0]
                if (prev >= FLIP_LOTS and today <= -FLIP_RATIO * prev) or (prev <= -FLIP_LOTS and today >= -FLIP_RATIO * prev):
                    fl.append({**base(c, q), "etf": is_etf(c), "prev": prev, "today": today,
                               "ratio": round(-today / prev * 100, 1)})
        st.sort(key=lambda r: -abs(r["cum"]))
        fl.sort(key=lambda r: -abs(r["prev"]))
        streaks[key] = [r for r in st if r["days"] > 0][:MAX_ROWS] + [r for r in st if r["days"] < 0][:MAX_ROWS]
        flips[key] = fl[:MAX_ROWS * 2]
        if key in ("fi", "it"):
            dv = []
            for c, q in pool.items():
                lots = lots_of(c, idx)
                if len(lots) < DIVERGE_DAYS:
                    continue
                cum = sum(lots[:DIVERGE_DAYS])
                pp = period_pct(qdays, c, DIVERGE_DAYS)
                if pp is None:
                    continue
                if (cum >= DIVERGE_LOTS and pp <= 0) or (cum <= -DIVERGE_LOTS and pp >= 0):
                    dv.append({**base(c, q), "etf": is_etf(c), "cum": cum, "today": lots[0], "ppct": pp})
            dv.sort(key=lambda r: -abs(r["cum"]))
            diverge[key] = dv[:MAX_ROWS * 2]

    return {
        "date": trade_date.isoformat(),
        "inst_dates": [d.isoformat() for d, _ in inst_days],
        "cats": {k: name for k, name, _ in CATS},
        "rules": {"min_vol": MIN_VOL, "streak_min": STREAK_MIN, "diverge_days": DIVERGE_DAYS,
                  "diverge_lots": DIVERGE_LOTS, "flip_lots": FLIP_LOTS, "flip_ratio": FLIP_RATIO},
        "streaks": streaks, "diverge": diverge, "flips": flips,
    }


def write(screens):
    OUT.write_text(json.dumps(screens, ensure_ascii=False, separators=(",", ":")))
