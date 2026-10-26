"""盤前速覽（台灣時間 07:15 排程）：期貨夜盤、匯率、今日事件。

資料來源（皆為官方公開資料）：
  - 夜盤       期交所 futDataDown（交易時段＝盤後）。期交所把「前一晚 15:00～隔天 05:00」的夜盤記在隔天的交易日，
               所以今天早上查「今天」的日期就是昨晚的夜盤；漲跌是相對前一個交易日的結算價
  - 匯率       期交所 dailyFXRateDown（每日外幣參考匯率，最近一個交易日）
  - 今日事件   data/events.json（除權息）、data/daytrade.json（處置、暫停先賣後買）、data/latest.json（選擇權結算日）
  - 國際市場   fetch_world（Yahoo Finance／Nasdaq.com，非官方介面）：美歐亞指數、美股期貨、債息匯率原物料、台積電 ADR 與相關美股
手動執行（休市日或夜盤還沒出）時，夜盤改用最近一個有資料的交易日並標明日期；排程執行則一定要當天的夜盤。
抓不到夜盤就丟 NotPublished，由排程決定要不要等；不用替代數字。輸出 data/pre.json。
"""
import json
from datetime import timedelta
from pathlib import Path

import fetch_fut

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "pre.json"
NIGHT = [("TX", "臺股期貨"), ("MTX", "小型臺指"), ("TE", "電子期貨"), ("TF", "金融期貨")]
FX = [("美元／新台幣", "USD/TWD"), ("美元／日幣", "USD/JPY"), ("美元／人民幣", "USD/CNY"), ("歐元／美元", "EUR/USD")]
FX_DAYS = 5


def night(d):
    """各契約近月的夜盤行情；近月＝當天有盤後成交的最近月份（不含週契約）"""
    out = []
    for code, name in NIGHT:
        rows = fetch_fut.day_rows("futDataDown", f"down_type=1&commodity_id={code}&commodity_id2=&{fetch_fut.rng(d)}", d, f"{code} 夜盤")
        rows = [r for r in rows if r["契約"] == code and r["交易時段"] == "盤後" and r["到期月份(週別)"].isdigit()
                and fetch_fut.fnum(r["收盤價"]) is not None]
        if not rows:
            raise fetch_fut.NotPublished(f"期交所 {d} {code} 夜盤尚未公布")
        r = min(rows, key=lambda r: r["到期月份(週別)"])
        close, chg = fetch_fut.fnum(r["收盤價"]), fetch_fut.fnum(r["漲跌價"])
        out.append({"code": code, "name": name, "month": r["到期月份(週別)"], "open": fetch_fut.fnum(r["開盤價"]),
                    "high": fetch_fut.fnum(r["最高價"]), "low": fetch_fut.fnum(r["最低價"]), "close": close, "change": chg,
                    "pct": round(chg / (close - chg) * 100, 2) if chg is not None and close - chg else None,
                    "volume": int(fetch_fut.fnum(r["成交量"]) or 0)})
    return out


def fx(d):
    rows = fetch_fut.get_csv("dailyFXRateDown", f"queryStartDate={d - timedelta(days=21):%Y/%m/%d}&queryEndDate={d:%Y/%m/%d}")
    rows = [fetch_fut.clean(r) for r in rows if fetch_fut.clean(r).get("日期")]
    rows.sort(key=lambda r: r["日期"])
    if len(rows) < 2:
        raise RuntimeError("期交所匯率資料不足")
    rows = rows[-(FX_DAYS + 1):]
    out = []
    for k, label in FX:
        vals = [fetch_fut.fnum(r[k]) for r in rows]
        out.append({"pair": label, "name": k, "dates": [r["日期"].replace("/", "-") for r in rows[1:]], "values": vals[1:],
                    "change": round(vals[-1] - vals[-2], 4) if None not in vals[-2:] else None})
    return out


def read(name):
    try:
        return json.loads((DATA / name).read_text())
    except (OSError, ValueError):
        return None


def events(d):
    t = d.isoformat()
    ev = read("events.json") or {}
    dt = read("daytrade.json") or {}
    latest = read("latest.json") or {}
    exr = [x for x in ev.get("exright", []) if t <= x["d"] <= (d + timedelta(days=7)).isoformat()]
    flags = {}
    if dt.get("next_day") == t:
        for r in dt.get("rows", []):
            for f in r["flags"]:
                if f in ("處置", "暫停先賣後買"):
                    flags.setdefault(f, []).append({"code": r["code"], "name": r["name"], "market": r["market"]})
    settle = [s["label"] for s in ((latest.get("fut") or {}).get("opt") or {}).get("series", []) if s.get("exp") == t]
    return {"exright": exr, "flags": flags, "flags_from": dt.get("date") if dt.get("next_day") == t else None,
            "settle": settle, "stock_date": latest.get("date")}


def tw_close(code):
    files = sorted((DATA / "quotes").glob("*.json"))
    return (json.loads(files[-1].read_text()).get(code) or [None])[0] if files else None


def session_start(nd):
    """夜盤記在 nd 交易日，實際是 nd 的前一個交易日晚上開盤；前一個交易日取自行情快取（data/quotes）"""
    days = sorted(f.stem for f in (DATA / "quotes").glob("*.json") if f.stem < f"{nd:%Y%m%d}")
    return f"{days[-1][:4]}-{days[-1][4:6]}-{days[-1][6:]}" if days else None


def build(d, now, warn, fallback=False):
    """夜盤記在「下一個交易日」：今天早上查今天的日期＝昨晚的夜盤。
    fallback＝True（手動執行）：今天沒有時先往後找（休市日時最新一晚的夜盤記在下一個交易日），再往前找"""
    import fetch_world
    cands = [d]
    if fallback:
        cands += [d + timedelta(days=k) for k in range(1, 8)] + [d - timedelta(days=k) for k in range(1, 11)]
    nd, nt = d, None
    for c in cands:
        if c.weekday() >= 5:
            continue
        try:
            nt, nd = night(c), c
            break
        except fetch_fut.NotPublished:
            if not fallback:
                raise
    if nt is None:
        raise fetch_fut.NotPublished(f"期交所 {d} 前後都沒有夜盤資料")
    fxs = fx(d)
    try:
        world = fetch_world.build(warn, tw_close("2330"), fxs[0]["values"][-1])
    except Exception as e:  # noqa: BLE001
        warn("國際市場未更新", e)
        world = None
    return {"date": d.isoformat(), "night_date": nd.isoformat(), "night_from": session_start(nd), "updated_at": now, "night": nt, "fx": fxs,
            "events": events(d), "world": world}


def write(v):
    OUT.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
