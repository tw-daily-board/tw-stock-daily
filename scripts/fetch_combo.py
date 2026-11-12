"""四項條件選股（籌碼篩選分頁）：估算融資維持率 < 130%、董監持股 > 30%、成交量 > 1,000 張、營收連續 2 個月成長。

全部用固定規則從公開資料計算，不用 LLM：
  - 融資維持率（估算）：證交所與櫃買只公布個股融資「張數」，沒有融資金額，所以用批次模型推估融資成本：
      每天融資餘額增加的張數，視為當天以收盤價融資買進的一批；
      融資餘額減少時，先扣掉已經跌破追繳線（維持率 < 130%）的批次（視為斷頭或償還，成本最高的先扣），
      還不夠再從最早的批次扣起。
      估算維持率 ＝ 收盤價 × 剩餘張數 ÷（各批成本 × 張數 × 融資成數）；融資成數一律假設六成，
      個股被調降成數、除權息、減資都沒有另外調整。狀態存在 data/combo/lots.json，每天接著前一天往下算；
      起始狀態用 2026-03-13 的融資餘額（視為當天收盤價買進），之後每個交易日依序推進。
  - 董監持股：證交所 openapi t187ap11_L（上市）、櫃買 openapi mopsfin_t187ap11_O（上櫃）的董監事逐人持股，
      加總董事長、副董事長、常務董事、董事、獨立董事、監察人「本人」的目前持股（法人董事算法人本身，
      不含法人代表人個人與關係人持股；同一人兼任多個職稱只算一次），
      除以 t187ap03_L／mopsfin_t187ap03_O 的已發行普通股數。每月更新，快取在 data/combo/directors.json，7 天重抓一次。
  - 成交量：當天行情（data/quotes）。
  - 營收：data/revenue（fetch_value 每月存的月營收），最新兩個月的月增率（或年增率）都 > 0。
輸出 data/combo.json：符合前三項的個股，附兩種營收成長率，網頁再依「月增／年增」切換第四項。
"""
import json
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT / "data" / "combo"
LOTS = STATE_DIR / "lots.json"
DIRECTORS = STATE_DIR / "directors.json"
OUT = ROOT / "data" / "combo.json"
MARGIN_DIR = ROOT / "data" / "margin"
QUOTE_DIR = ROOT / "data" / "quotes"
REV_DIR = ROOT / "data" / "revenue"

RATE = 0.6          # 融資成數（假設）
CALL = 1.3          # 追繳線：維持率 130%
MR_MAX = 130        # 條件 1：估算融資維持率 < 130%
DIR_MIN = 30        # 條件 2：董監持股 > 30%
VOL_MIN = 1000      # 條件 3：成交量 > 1,000 張
MAX_LOTS = 40       # 每檔最多保留幾批（超過就把最早的兩批合併）
DIR_REFRESH_DAYS = 7
ROLES = {"董事長本人", "副董事長本人", "常務董事本人", "董事本人", "獨立董事本人", "監察人本人"}


def fnum(s):
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


# ---------- 融資批次模型 ----------
def step(lots, bal, close):
    """lots：[[張數, 成本], ...]（舊→新）；依今天的融資餘額 bal 與收盤價 close 推進一天"""
    delta = bal - sum(s for s, _ in lots)
    if delta > 0:
        lots.append([delta, close])
    elif delta < 0:
        need = -delta
        for lot in sorted((l for l in lots if close / (l[1] * RATE) < CALL), key=lambda l: -l[1]):
            take = min(lot[0], need)
            lot[0] -= take
            need -= take
            if not need:
                break
        for lot in lots:
            if not need:
                break
            take = min(lot[0], need)
            lot[0] -= take
            need -= take
        lots[:] = [l for l in lots if l[0] > 0]
    while len(lots) > MAX_LOTS:
        (s1, c1), (s2, c2) = lots[0], lots[1]
        lots[:2] = [[s1 + s2, (s1 * c1 + s2 * c2) / (s1 + s2)]]
    return lots


def ratio(lots, close):
    shares = sum(s for s, _ in lots)
    amount = sum(s * c for s, c in lots) * RATE
    return round(close * shares / amount * 100, 1) if amount and shares else None


def advance(state, day, margin, quotes, keep, prune=True):
    """把狀態推進到 day：margin {代號: [名稱, 市場, 融資餘額, ...]}、quotes {代號: [收盤, 漲跌, 張數]}；
    prune：融資融券表上沒有的代號（下市、停止信用交易）就刪掉狀態"""
    rows = state["rows"]
    for c, r in margin.items():
        bal = r[2]
        close = (quotes.get(c) or [None])[0]
        if not keep(c) or bal is None or not close:
            continue   # 沒有收盤價（停牌等）：這天不推進，下次有價格時再用當天餘額
        if c not in rows:
            rows[c] = [[bal, close]] if bal else []   # 新上市或新列入：當天餘額視為當天收盤價買進
            continue
        step(rows[c], bal, close)
    for c in list(rows) if prune else []:
        if c not in margin:
            del rows[c]   # 下市、停止信用交易
    state["date"] = day.isoformat()


def save_lots(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    rows = {c: [[int(s), round(p, 2)] for s, p in lots] for c, lots in sorted(state["rows"].items())}
    LOTS.write_text(json.dumps({"date": state["date"], "rate": RATE, "rows": rows}, separators=(",", ":")))


def update_lots(dates, keep):
    """dates：交易日清單（新→舊，至少涵蓋 data/margin 的快取天數）；把狀態從上次的日期推進到最新一天"""
    if not LOTS.exists():
        raise RuntimeError(f"沒有融資批次狀態 {LOTS.relative_to(ROOT)}，無法估算融資維持率")
    state = json.loads(LOTS.read_text())
    last = date.fromisoformat(state["date"])
    todo = sorted(d for d in dates if d > last)
    if not todo:
        return state
    older = [d for d in dates if d <= last]
    if not older or older[0] != last:
        raise RuntimeError(f"融資批次狀態停在 {last}，不在近期交易日清單內，中間的融資資料已經不在快取，無法接續")
    for d in todo:
        mp, qp = MARGIN_DIR / f"{d:%Y%m%d}.json", QUOTE_DIR / f"{d:%Y%m%d}.json"
        if not mp.exists() or not qp.exists():
            raise RuntimeError(f"{d} 的{'融資融券' if not mp.exists() else '行情'}快取不存在，融資批次狀態無法從 {state['date']} 接續")
        advance(state, d, json.loads(mp.read_text()), json.loads(qp.read_text()), keep)
    save_lots(state)
    return state


# ---------- 董監持股 ----------
def fetch_directors(get_json, gap):
    issued = {}
    for x in get_json("https://openapi.twse.com.tw/v1/opendata/t187ap03_L"):
        issued[str(x.get("公司代號", "")).strip()] = fnum(x.get("已發行普通股數或TDR原股發行股數"))
    n_l = len(issued)
    time.sleep(gap)
    for x in get_json("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"):
        issued[str(x.get("SecuritiesCompanyCode", "")).strip()] = fnum(x.get("IssueShares"))
    if n_l < 900 or len(issued) - n_l < 700:
        raise RuntimeError(f"已發行股數筆數異常：上市 {n_l}、上櫃 {len(issued) - n_l}")
    hold, seen, yms = {}, set(), set()
    for url, min_rows in (("https://openapi.twse.com.tw/v1/opendata/t187ap11_L", 15000),
                          ("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap11_O", 10000)):
        time.sleep(gap)
        rows = get_json(url)
        if len(rows) < min_rows:
            raise RuntimeError(f"董監持股筆數異常（{len(rows)} 筆）：{url}")
        for x in rows:
            yms.add(str(x.get("資料年月", "")).strip())
            if str(x.get("職稱", "")).strip() not in ROLES:
                continue
            c, who = str(x.get("公司代號", "")).strip(), str(x.get("姓名", "")).strip()
            if (c, who) in seen:
                continue
            seen.add((c, who))
            hold[c] = hold.get(c, 0) + (fnum(x.get("目前持股")) or 0)
    pct = {c: round(h / issued[c] * 100, 2) for c, h in sorted(hold.items()) if issued.get(c)}
    if len(pct) < 1500:
        raise RuntimeError(f"董監持股比例只算出 {len(pct)} 檔")
    ym = max(yms)   # 民國年月，例如 11509
    return {"ym": f"{int(ym[:-2]) + 1911}-{ym[-2:]}", "pct": pct}


def load_directors(get_json, today, gap, warn):
    cache = json.loads(DIRECTORS.read_text()) if DIRECTORS.exists() else None
    if cache and date.fromisoformat(cache["fetched"]) > today - timedelta(days=DIR_REFRESH_DAYS):
        return cache
    try:
        new = fetch_directors(get_json, gap)
    except Exception as e:  # noqa: BLE001
        if not cache:
            raise
        warn("董監持股未更新（沿用快取）", e)
        return cache
    new["fetched"] = today.isoformat()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DIRECTORS.write_text(json.dumps(new, ensure_ascii=False, separators=(",", ":")))
    return new


# ---------- 營收 ----------
def prev_ym(ym):
    y, m = int(ym[:4]), int(ym[4:])
    return f"{y - 1}12" if m == 1 else f"{y}{m - 1:02d}"


def load_revenue():
    files = sorted(REV_DIR.glob("*.json"), reverse=True)
    if not files:
        raise RuntimeError("沒有月營收資料")
    cur = files[0].stem
    p0 = REV_DIR / f"{prev_ym(cur)}.json"
    if not p0.exists():
        raise RuntimeError(f"缺 {prev_ym(cur)} 月營收，無法判斷連續 2 個月成長")
    return [prev_ym(cur), cur], [json.loads(p0.read_text()), json.loads(files[0].read_text())]


# ---------- 輸出 ----------
def build(state, directors):
    d = date.fromisoformat(state["date"])
    margin = json.loads((MARGIN_DIR / f"{d:%Y%m%d}.json").read_text())
    quotes = json.loads((QUOTE_DIR / f"{d:%Y%m%d}.json").read_text())
    months, revs = load_revenue()
    pct = directors["pct"]
    rows, cnt = [], {"mr": 0, "dir": 0, "vol": 0, "all3": 0}
    for c, lots in state["rows"].items():
        q = quotes.get(c)
        if not q or not q[0]:
            continue
        close, chg, vol = q
        mr = ratio(lots, close)
        a, b, v = mr is not None and mr < MR_MAX, (pct.get(c) or 0) > DIR_MIN, (vol or 0) > VOL_MIN
        cnt["mr"] += a
        cnt["dir"] += b
        cnt["vol"] += v
        if not (a and b and v):
            continue
        cnt["all3"] += 1
        rv = [r.get(c) or {} for r in revs]
        rows.append({
            "code": c, "name": margin[c][0], "market": margin[c][1], "close": close,
            "pct": round(chg / (close - chg) * 100, 2) if chg is not None and close - chg > 0 else None,
            "volume": vol, "fin": int(sum(s for s, _ in lots)), "mr": mr, "dir": pct[c],
            "mom": [r.get("mom") for r in rv], "yoy": [r.get("yoy") for r in rv],
        })
    rows.sort(key=lambda r: r["mr"])
    return {"date": state["date"], "dir_ym": directors["ym"], "rev_months": [f"{m[:4]}-{m[4:]}" for m in months],
            "rules": {"mr": MR_MAX, "dir": DIR_MIN, "vol": VOL_MIN, "rate": RATE, "call": CALL},
            "counts": cnt, "rows": rows}


def update(get_json, dates, keep, gap, warn, today):
    """融資融券更新成功後呼叫；dates：交易日清單（新→舊）"""
    state = update_lots(dates, keep)
    directors = load_directors(get_json, today, gap, warn)
    out = build(state, directors)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return out
