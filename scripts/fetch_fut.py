"""台指期盤後快訊：收盤行情表、三大法人籌碼變化、十大交易人期權淨部位。

資料全部來自期交所網站的 CSV 下載（可指定日期，所以前一交易日也能直接查，不需自己存歷史）與證交所：
  - 每日行情     cht/3/futDataDown
  - 三大法人     cht/3/futContractsDateDown、cht/3/callsAndPutsDateDown
  - 大額交易人   cht/3/largeTraderFutDown、cht/3/largeTraderOptDown
  - 現貨買賣超   證交所 BFI82U；加權指數與成交金額 證交所 FMTQIK
不用 openapi.taifex.com.tw：它比網站晚更新（當天晚上仍是前一交易日）。
"""
import csv
import io
import json
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

TAIFEX = "https://www.taifex.com.tw/cht/3/"
FUT_DIR = Path(__file__).resolve().parent.parent / "data" / "fut"
KEEP_SNAPSHOTS = 5
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}

# 收盤行情表：(顯示名稱, 契約代號, 取幾個月份)；近月＋次月，分類指數期只取近月
QUOTE_ROWS = [("台指", "TX", 2), ("小台", "MTX", 2), ("微台", "TMF", 2),
              ("電子", "TE", 1), ("金融", "TF", 1), ("非金", "XIF", 1)]
INST_NAMES = {"自營商": "dl", "投信": "it", "外資及陸資": "fi"}
ALL_MONTHS = ("999912", "999999")   # 大額交易人「所有契約」
SKIP_MONTHS = ("666666",) + ALL_MONTHS  # 666666＝週契約合計


class NotPublished(RuntimeError):
    pass


def fnum(s):
    try:
        return float(str(s).replace(",", "").replace("%", "").replace("+", "").strip())
    except ValueError:
        return None


def get_csv(path, params, gap=1.0, retries=4):
    """下載期交所 CSV（Big5）；沒有資料列（假日、尚未公布）回傳空 list。"""
    url = TAIFEX + path + "?" + params
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                text = r.read().decode("cp950", "replace")
            time.sleep(gap)
            return list(csv.DictReader(io.StringIO(text)))
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            print(f"[retry {i + 1}/{retries}] {url} -> {last}", file=sys.stderr)
            time.sleep(2 ** (i + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def rng(d):
    return f"queryStartDate={d:%Y/%m/%d}&queryEndDate={d:%Y/%m/%d}"


def clean(r):
    return {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in r.items() if k}


def check_day(rows, d, what):
    rows = [clean(r) for r in rows]
    rows = [r for r in rows if r.get(next(iter(r), ""), "").replace("/", "-") == d.isoformat()] if rows else []
    if not rows:
        raise NotPublished(f"期交所 {d} {what} 無資料（假日或尚未公布）")
    return rows


# ---------- 收盤行情 ----------
def parse_quotes(d):
    out = {}
    for code in [c for _, c, _ in QUOTE_ROWS]:
        rows = check_day(get_csv("futDataDown", f"down_type=1&commodity_id={code}&commodity_id2=&{rng(d)}"), d, f"{code} 行情")
        months = {}
        for r in rows:
            m = r["到期月份(週別)"]
            if r["契約"] != code or not m.isdigit() or len(m) != 6:
                continue
            q = months.setdefault(m, {"vol": 0, "settle": None, "oi": None, "ref": None})
            q["vol"] += int(fnum(r["成交量"]) or 0)                     # 一般 + 盤後
            if r["交易時段"] == "一般":
                q["settle"] = fnum(r["結算價"])
                q["oi"] = fnum(r["未沖銷契約數"])
                last, chg = fnum(r["收盤價"]), fnum(r["漲跌價"])
                if last is not None and chg is not None:
                    q["ref"] = round(last - chg, 4)                      # 前一日結算價
        out[code] = months
    return out


# ---------- 三大法人 ----------
def parse_inst(d):
    fut = check_day(get_csv("futContractsDateDown", rng(d)), d, "三大法人期貨")
    opt = check_day(get_csv("callsAndPutsDateDown", rng(d) + "&commodityId=TXO"), d, "三大法人選擇權")
    out = {k: {} for k in INST_NAMES.values()}
    for r in fut:
        if r["商品名稱"] == "臺股期貨" and r["身份別"] in INST_NAMES:
            out[INST_NAMES[r["身份別"]]]["fut"] = int(fnum(r["多空未平倉口數淨額"]))
    for r in opt:
        if r["商品名稱"] == "臺指選擇權" and r["身份別"] in INST_NAMES:
            k, cp = INST_NAMES[r["身份別"]], r["買賣權別"].lower()
            out[k][cp] = int(fnum(r["未平倉口數買賣淨額"]))
            out[k][cp + "_amt"] = round(fnum(r["未平倉契約金額買賣淨額(千元)"]) / 1e5, 2)  # 千元→億
    for k, v in out.items():
        if len(v) != 5:
            raise RuntimeError(f"三大法人 {k} 欄位不全：{v}")
    return out


# ---------- 十大交易人 ----------
def parse_large(d):
    f = check_day(get_csv("largeTraderFutDown", f"{rng(d)}&contractId=TX"), d, "十大交易人期貨")
    o = check_day(get_csv("largeTraderOptDown", f"{rng(d)}&contractId=TXO"), d, "十大交易人選擇權")

    def board(rows, match):
        """{月份: {類型: 十大買-十大賣}}；類型 0＝全部交易人、1＝特定法人；所有到期月份＝ALL_MONTHS"""
        net, oi = {}, {}
        for r in rows:
            if not match(r):
                continue
            m, t = r["到期月份(週別)"], r["交易人類別"]
            net.setdefault(m, {})[t] = int(fnum(r["前十大交易人買方"]) - fnum(r["前十大交易人賣方"]))
            oi[m] = int(fnum(r["全市場未沖銷部位數"]))
        allm = next((m for m in ALL_MONTHS if m in net), None)
        months = sorted(m for m in net if m.isdigit() and m not in SKIP_MONTHS)
        if not months or allm is None:
            raise RuntimeError("十大交易人缺少月份資料")
        near = months[0]
        spec_n, spec_a = net[near]["1"], net[allm]["1"]
        all_n, all_a = net[near]["0"], net[allm]["0"]
        return {"month": near, "oi": oi[allm], "sp_near": spec_n, "sp_far": spec_a - spec_n,
                "ot_near": all_n - spec_n, "ot_far": (all_a - spec_a) - (all_n - spec_n)}

    return {
        "fut": board(f, lambda r: r["商品(契約)"] == "TX"),
        "call": board(o, lambda r: r["商品(契約)"] == "TXO" and r["買賣權"] == "買權"),
        "put": board(o, lambda r: r["商品(契約)"] == "TXO" and r["買賣權"] == "賣權"),
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
def snapshot(d):
    return {"date": d.isoformat(), "quotes": parse_quotes(d), "inst": parse_inst(d), "large": parse_large(d)}


def load_snapshot(d):
    """先看 data/fut/ 有沒有快取，沒有才向期交所抓"""
    p = FUT_DIR / f"{d:%Y%m%d}.json"
    if p.exists():
        return json.loads(p.read_text())
    snap = snapshot(d)
    FUT_DIR.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
    return snap


def previous_snapshot(d):
    """往前找最近一個有資料的交易日（最多 10 天）"""
    for i in range(1, 11):
        try:
            return load_snapshot(d - timedelta(days=i))
        except NotPublished:
            continue
    return None


def build(get_json, trade_date: date, gap=3.0):
    # 當天的資料不用快取，確保晚間補公布的內容會更新
    (FUT_DIR / f"{trade_date:%Y%m%d}.json").unlink(missing_ok=True)
    snap = load_snapshot(trade_date)
    prev = previous_snapshot(trade_date)
    for p in sorted(FUT_DIR.glob("*.json"))[:-KEEP_SNAPSHOTS]:
        p.unlink()
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
