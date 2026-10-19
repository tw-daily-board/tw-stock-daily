"""台指期盤後快訊：收盤行情表、三大法人籌碼變化、十大交易人期權淨部位。

資料全部來自期交所開放資料（openapi.taifex.com.tw）與證交所：
  - 每日行情     DailyMarketReportFut
  - 三大法人     MarketDataOfMajorInstitutionalTradersDetailsOf{FuturesContracts,CallsAndPuts}BytheDate
  - 大額交易人   OpenInterestOfLargeTraders{Futures,Options}
  - 現貨買賣超   證交所 BFI82U；加權指數與成交金額 證交所 FMTQIK
期交所 API 只保留最新一個交易日，「變化」欄靠 data/fut/ 內前一個交易日的快照相減。
"""
import json
import time
from datetime import date
from pathlib import Path

TAIFEX = "https://openapi.taifex.com.tw/v1/"
FUT_DIR = Path(__file__).resolve().parent.parent / "data" / "fut"
KEEP_SNAPSHOTS = 5

# 收盤行情表：(顯示名稱, 契約代號, 取幾個月份)；近月＋次月，分類指數期只取近月
QUOTE_ROWS = [("台指", "TX", 2), ("小台", "MTX", 2), ("微台", "TMF", 2),
              ("電子", "TE", 1), ("金融", "TF", 1), ("非金", "XIF", 1)]
INST_NAMES = {"自營商": "dl", "投信": "it", "外資及陸資": "fi"}


def fnum(s):
    try:
        return float(str(s).replace(",", "").replace("%", "").replace("+", "").strip())
    except ValueError:
        return None


def d8(s):
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def only_date(rows, key="Date"):
    ds = {r[key] for r in rows}
    if len(ds) != 1:
        raise RuntimeError(f"期交所資料日期不唯一：{sorted(ds)}")
    return ds.pop()


# ---------- 收盤行情 ----------
def parse_quotes(get_json):
    rows = get_json(TAIFEX + "DailyMarketReportFut")
    day = only_date(rows)
    out = {}
    for code in {c for _, c, _ in QUOTE_ROWS}:
        months = {}
        for r in rows:
            m = r["ContractMonth(Week)"]
            if r["Contract"] != code or not m.isdigit() or len(m) != 6:
                continue
            q = months.setdefault(m, {"vol": 0, "settle": None, "oi": None, "ref": None})
            q["vol"] += int(fnum(r["Volume"]) or 0)                 # 一般 + 盤後
            if r["TradingSession"] == "一般":
                q["settle"] = fnum(r["SettlementPrice"])
                q["oi"] = fnum(r["OpenInterest"])
                last, chg = fnum(r["Last"]), fnum(r["Change"])
                if last is not None and chg is not None:
                    q["ref"] = round(last - chg, 4)                  # 前一日結算價
        out[code] = months
    return day, out


# ---------- 三大法人 ----------
def parse_inst(get_json):
    fut = get_json(TAIFEX + "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate")
    opt = get_json(TAIFEX + "MarketDataOfMajorInstitutionalTradersDetailsOfCallsAndPutsBytheDate")
    day = only_date(fut)
    if only_date(opt) != day:
        raise RuntimeError("三大法人期貨與選擇權日期不一致")
    out = {k: {} for k in INST_NAMES.values()}
    for r in fut:
        if r["ContractCode"] == "臺股期貨" and r["Item"] in INST_NAMES:
            out[INST_NAMES[r["Item"]]]["fut"] = int(fnum(r["OpenInterest(Net)"]))
    for r in opt:
        if r["ContractCode"] == "臺指選擇權" and r["Item"] in INST_NAMES:
            k, cp = INST_NAMES[r["Item"]], r["CallPut"].lower()
            out[k][cp] = int(fnum(r["OpenInterest(Net)"]))
            out[k][cp + "_amt"] = round(fnum(r["ContractValueofOpenInterest(Net)(Thousands)"]) / 1e5, 2)  # 千元→億
    for k, v in out.items():
        if len(v) != 5:
            raise RuntimeError(f"三大法人 {k} 欄位不全：{v}")
    return day, out


# ---------- 十大交易人 ----------
def parse_large(get_json):
    f = get_json(TAIFEX + "OpenInterestOfLargeTradersFutures")
    o = get_json(TAIFEX + "OpenInterestOfLargeTradersOptions")
    day = only_date(f)
    if only_date(o) != day:
        raise RuntimeError("十大交易人期貨與選擇權日期不一致")

    def board(rows, match):
        """回傳 {月份: {類型: 十大買-十大賣}} 與各月份全市場 OI；月份 999912＝全部到期月"""
        net, oi = {}, {}
        for r in rows:
            if not match(r):
                continue
            m, t = r["SettlementMonth"], r["TypeOfTraders"]       # t=0 全部交易人、1 特定法人
            net.setdefault(m, {})[t] = int(fnum(r["Top10Buy"]) - fnum(r["Top10Sell"]))
            oi[m] = int(fnum(r["OIOfMarket"]))
        months = sorted(m for m in net if m.isdigit() and m not in ("666666", "999912"))
        if not months or "999912" not in net:
            raise RuntimeError("十大交易人缺少月份資料")
        near = months[0]
        res = {"month": near, "oi": oi["999912"]}
        spec_n, spec_a = net[near]["1"], net["999912"]["1"]
        all_n, all_a = net[near]["0"], net["999912"]["0"]
        res.update({"sp_near": spec_n, "sp_far": spec_a - spec_n,
                    "ot_near": all_n - spec_n, "ot_far": (all_a - spec_a) - (all_n - spec_n)})
        return res

    return day, {
        "fut": board(f, lambda r: r["Contract"] == "TX"),
        "call": board(o, lambda r: r["Contract"] == "TXO" and r["CallPut"] == "買權"),
        "put": board(o, lambda r: r["Contract"] == "TXO" and r["CallPut"] == "賣權"),
    }


# ---------- 現貨（證交所） ----------
def fetch_cash(get_json, d):
    """三大法人現貨買賣超金額（億元）與加權指數、成交金額（兆元）"""
    j = get_json(f"https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate={d:%Y%m%d}&type=day&response=json")
    if j.get("stat") != "OK":
        raise RuntimeError("BFI82U 無資料")
    rows = {r[0].strip(): fnum(r[3]) for r in j["data"]}
    fi = rows["外資及陸資(不含外資自營商)"] + rows.get("外資自營商", 0)
    dl = rows["自營商(自行買賣)"] + rows["自營商(避險)"]
    cash = {"fi": fi, "it": rows["投信"], "dl": dl}
    time.sleep(3)
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date={d:%Y%m%d}&response=json")
    row = next((r for r in j.get("data", []) if r[0].replace("/", "") == f"{d.year - 1911}{d:%m%d}"), None)
    if row is None:
        raise RuntimeError("FMTQIK 找不到當日")
    idx = {"close": fnum(row[4]), "change": fnum(row[5]), "value_tril": fnum(row[2]) / 1e12}
    idx["pct"] = round(idx["change"] / (idx["close"] - idx["change"]) * 100, 2)
    return {k: round(v / 1e8, 2) for k, v in cash.items()}, idx


# ---------- 快照與組表 ----------
def load_prev(day):
    FUT_DIR.mkdir(parents=True, exist_ok=True)
    older = sorted(p for p in FUT_DIR.glob("*.json") if p.stem < day.replace("-", ""))
    return json.loads(older[-1].read_text()) if older else None


def snapshot(get_json):
    d1, quotes = parse_quotes(get_json)
    d2, inst = parse_inst(get_json)
    d3, large = parse_large(get_json)
    if not (d1 == d2 == d3):
        raise RuntimeError(f"期交所各資料集日期不一致：行情 {d1}、法人 {d2}、十大交易人 {d3}（可能尚未全部公布）")
    return {"date": d8(d1), "quotes": quotes, "inst": inst, "large": large}


def build(get_json, trade_date: date, gap=3.0):
    snap = snapshot(get_json)
    if snap["date"] != trade_date.isoformat():
        raise RuntimeError(f"期交所資料日期 {snap['date']} 與交易日 {trade_date} 不一致（尚未公布）")
    FUT_DIR.mkdir(parents=True, exist_ok=True)
    (FUT_DIR / f"{snap['date'].replace('-', '')}.json").write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
    for p in sorted(FUT_DIR.glob("*.json"))[:-KEEP_SNAPSHOTS]:
        p.unlink()
    prev = load_prev(snap["date"])
    time.sleep(gap)
    cash, idx = fetch_cash(get_json, trade_date)
    return compose(snap, prev, cash, idx)


def delta(cur, old):
    return None if old is None else round(cur - old, 2)


def compose(snap, prev, cash, idx):
    # 收盤行情表
    market = []
    for label, code, n in QUOTE_ROWS:
        months = sorted(snap["quotes"][code])
        # 近月：最小的月份；已到期（無一般盤結算價）的略過
        months = [m for m in months if snap["quotes"][code][m]["settle"] is not None][:n]
        for m in months:
            q = snap["quotes"][code][m]
            pq = (prev or {}).get("quotes", {}).get(code, {}).get(m)
            ref = pq["settle"] if pq and pq.get("settle") is not None else q["ref"]
            chg = None if ref is None else round(q["settle"] - ref, 2)
            market.append({
                "name": f"{label}{m[4:]}", "close": q["settle"], "change": chg,
                "pct": None if not ref else round(chg / ref * 100, 2),
                "volume": q["vol"], "oi": int(q["oi"]), "oi_chg": None if not pq or pq.get("oi") is None else int(q["oi"] - pq["oi"]),
            })
    # 三大法人籌碼變化（口數）；合計為三者相加
    inst = []
    for key, label in (("fi", "外資"), ("it", "投信"), ("dl", "自營商")):
        inst.append({"name": label, "cash": cash[key], **{k: snap["inst"][key][k] for k in snap["inst"][key]},
                     **{k + "_d": delta(snap["inst"][key][k], (prev or {}).get("inst", {}).get(key, {}).get(k)) for k in snap["inst"][key]}})
    tot = {"name": "合計", "cash": round(sum(r["cash"] for r in inst), 2)}
    for k in ("fut", "call", "put", "call_amt", "put_amt"):
        tot[k] = round(sum(r[k] for r in inst), 2)
        tot[k + "_d"] = None if any(r[k + "_d"] is None for r in inst) else round(sum(r[k + "_d"] for r in inst), 2)
    inst.append(tot)
    # 十大交易人淨部位
    large = []
    for key, label in (("fut", "台指"), ("call", "買權"), ("put", "賣權")):
        cur, old = snap["large"][key], (prev or {}).get("large", {}).get(key)
        row = {"name": label}
        for k in ("sp_near", "sp_far", "ot_near", "ot_far", "oi"):
            row[k] = cur[k]
            row[k + "_d"] = None if not old else cur[k] - old[k]
        large.append(row)
    return {"date": snap["date"], "prev_date": prev["date"] if prev else None, "index": idx,
            "market": market, "inst": inst, "large": large}
