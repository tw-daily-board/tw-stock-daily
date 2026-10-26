"""綜合訊號表：把現貨法人、借券、市場廣度、融資融券、期貨、選擇權的資料，用固定規則轉成一行一行的訊號。

分「短線」（看今天的變化）與「中期」（看 20～60 日，取自 data/trend.json）。每條訊號 bias：+1 偏多、-1 偏空、0 中性；
只是資訊的項目不計分。判讀先算各面向（現貨籌碼、期權籌碼、市場廣度、情緒槓桿、指數位置）內計分項目的加總正負，
再看偏多與偏空的面向數相差 2 個以上才判為偏多或偏空，避免某一類規則比較多就主導結果。
規則都是固定門檻，不是預測，也不構成投資建議。

額外資料（每日快取在 data/chips/，第一次回補，之後每天只抓新的一天）：
  - 融資融券   證交所 MI_MARGN（信用交易統計）、櫃買中心 margin/balance（合計列）
  - 法人金額   證交所 BFI82U（三大法人買賣金額，上市）
融資融券約晚上才公布；還沒公布時，融資融券相關訊號會標示「尚未公布」。
"""
import json
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHIPS_DIR = ROOT / "data" / "chips"
FUT_DIR = ROOT / "data" / "fut"
DAYS = 10
RETAIL_TH = 10        # 小台散戶多空比與前幾日平均相差幾個百分點才判讀


class MarginNotReady(RuntimeError):
    pass


def fnum(s):
    try:
        return float(str(s).replace(",", "").replace("+", "").strip())
    except ValueError:
        return None


# ---------- 每日籌碼（融資融券、三大法人金額） ----------
def fetch_chips(get_json, d, gap):
    """單日籌碼；假日回傳 None；三大法人金額有但融資融券還沒出時丟 MarginNotReady"""
    j = get_json(f"https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate={d:%Y%m%d}&type=day&response=json")
    if j.get("stat") != "OK" or not j.get("data"):
        return None
    rows = {r[0].strip(): fnum(r[3]) for r in j["data"]}
    inst = {"fi": round((rows["外資及陸資(不含外資自營商)"] + rows.get("外資自營商", 0)) / 1e8, 2),
            "it": round(rows["投信"] / 1e8, 2),
            "dl": round((rows["自營商(自行買賣)"] + rows["自營商(避險)"]) / 1e8, 2)}
    time.sleep(gap)
    m = get_json(f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={d:%Y%m%d}&selectType=MS&response=json")
    t = next((t for t in m.get("tables") or [] if "信用交易統計" in (t.get("title") or "")), None)
    if m.get("stat") != "OK" or not t or not t.get("data"):
        raise MarginNotReady(f"{d} 上市融資融券尚未公布")
    mr = {r[0]: r for r in t["data"]}
    tw = {"fin_amt": round(fnum(mr["融資金額(仟元)"][5]) / 1e5, 2),     # 仟元→億
          "fin_lots": int(fnum(mr["融資(交易單位)"][5])), "short_lots": int(fnum(mr["融券(交易單位)"][5]))}
    time.sleep(gap)
    p = get_json(f"https://www.tpex.org.tw/www/zh-tw/margin/balance?date={d:%Y/%m/%d}&response=json")
    pt = (p.get("tables") or [None])[0]
    summ = {r[1]: r for r in (pt or {}).get("summary") or []}
    if "合計(張)" not in summ or "融資金(仟元)" not in summ:
        raise MarginNotReady(f"{d} 上櫃融資融券尚未公布")
    tp = {"fin_amt": round(fnum(summ["融資金(仟元)"][6]) / 1e5, 2),
          "fin_lots": int(fnum(summ["合計(張)"][6])), "short_lots": int(fnum(summ["合計(張)"][14]))}
    return {"date": d.isoformat(), "inst": inst, "margin": {"twse": tw, "tpex": tp}}


def load_chips(get_json, dates, gap):
    """dates：交易日清單（新→舊，取自法人快取，不用猜哪天休市）；當天融資融券還沒出時丟 MarginNotReady"""
    CHIPS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for d in dates[:DAYS]:
        p = CHIPS_DIR / f"{d:%Y%m%d}.json"
        if p.exists():
            out.append(json.loads(p.read_text()))
            continue
        time.sleep(gap)
        rec = fetch_chips(get_json, d, gap)
        if not rec:
            raise MarginNotReady(f"{d} 三大法人金額尚未公布")
        p.write_text(json.dumps(rec, ensure_ascii=False))
        out.append(rec)
    keep = {f"{d:%Y%m%d}.json" for d in dates[:DAYS]}
    for p in CHIPS_DIR.glob("*.json"):
        if p.name not in keep:
            p.unlink()
    return out


# ---------- 規則 ----------
def streak(vals):
    """vals 新→舊；回傳與第一個同號的連續天數，帶正負號（+3＝連 3 天為正、-2＝連 2 天為負）"""
    if not vals or not vals[0]:
        return 0
    s = 1 if vals[0] > 0 else -1
    n = 0
    for v in vals:
        if v * s > 0:
            n += 1
        else:
            break
    return n * s


def sgn(v, th=0):
    return 1 if v > th else -1 if v < -th else 0


def fmt(v, d=0, unit=""):
    if v is None:
        return "-"
    s = f"{v:+,.{d}f}" if v else f"{v:,.{d}f}"
    return s + unit


def streak_text(n, pos="買超", neg="賣超"):
    return f"連續{pos if n > 0 else neg} {abs(n)} 天" if n else ""


DIMS = {"spot": "現貨籌碼", "fut": "期權籌碼", "breadth": "市場廣度", "sentiment": "情緒槓桿", "position": "指數位置"}
TERMS = {"short": ("短線", ["spot", "fut", "breadth", "sentiment"]), "mid": ("中期", ["position", "spot", "fut", "breadth", "sentiment"])}
EXTREME = 10          # 60 日區間的前後 10% 才算極端
SBL_TH_1D = 0.3       # 全市場借券賣出餘額單日變化 ±0.3%
SBL_TH_5D = 1.0       # 5 日變化 ±1%
FI20_TH = 1000        # 外資 20 日累計 ±1,000 億
SBL_DIR = ROOT / "data" / "sbl"


def pct_rank(vals, cur):
    """cur 在 vals（含 cur）中的百分位：0＝最低、100＝最高"""
    vals = [v for v in vals if v is not None]
    return round(sum(1 for v in vals if v < cur) / (len(vals) - 1) * 100) if len(vals) > 1 else None


def extreme(p, high_is):
    """百分位在前後 EXTREME% 才判讀；high_is：位於高檔時的方向（+1 或 -1）"""
    if p is None:
        return 0
    return high_is if p >= 100 - EXTREME else -high_is if p <= EXTREME else 0


def sbl_totals(upto):
    """全市場（上市櫃普通股）借券賣出餘額、當日借券賣出、還券（張），新→舊"""
    import re
    out = []
    for f in sorted(SBL_DIR.glob("*.json"), reverse=True) if SBL_DIR.exists() else []:
        d = f"{f.stem[:4]}-{f.stem[4:6]}-{f.stem[6:]}"
        if d > upto:
            continue
        rec = json.loads(f.read_text())
        vs = [v for c, v in rec.items() if re.fullmatch(r"\d{4}", c)]
        out.append({"date": d, "bal": sum(v[2] for v in vs), "sell": sum(v[3] or 0 for v in vs), "ret": sum(v[4] or 0 for v in vs)})
    return out


def signals(out, chips, chips_err, trend=None):
    items = []

    def add(group, name, value, detail, bias, dim=None, term="short"):
        """dim＝None 的只是資訊，不計分"""
        items.append({"group": group, "name": name, "value": value, "detail": detail, "bias": bias if dim else 0,
                      "dim": dim, "term": term, "scored": dim is not None})

    # ================= 短線（看今天） =================
    # ---- 現貨法人（上市，億元） ----
    if chips:
        for key, label, th in (("fi", "外資現貨", 30), ("it", "投信現貨", 10), ("dl", "自營商現貨", None)):
            vals = [c["inst"][key] for c in chips]
            n = streak(vals)
            add("現貨法人", label, fmt(vals[0], 2, " 億"),
                "；".join(x for x in (streak_text(n), f"近 {len(vals)} 日累計 {fmt(sum(vals), 2, ' 億')}") if x),
                0 if th is None else sgn(vals[0], th), None if th is None else "spot")
    tsmc = next((r for r in out.get("cap", []) if r["code"] == "2330"), None)
    if tsmc:
        add("現貨法人", "台積電外資", fmt(tsmc["fi_today"], 0, " 張"),
            f"近 10 日 {fmt(tsmc['fi_10d'])} 張；收盤 {tsmc['close']:,.0f}（{fmt(tsmc['pct'], 2, '%')}）", sgn(tsmc["fi_today"], 1000), "spot")
    cap = out.get("cap", [])
    if cap:
        tot = sum(r["fi_today"] for r in cap)
        n_buy = sum(1 for r in cap if r["fi_today"] > 0)
        add("現貨法人", "前 20 大權值股外資合計", fmt(tot, 0, " 張"), f"外資買超 {n_buy} 檔、賣超 {len(cap) - n_buy} 檔", sgn(tot, 5000), "spot")
    # ---- 借券賣出（全市場普通股） ----
    sb = sbl_totals(out["date"])
    if sb and sb[0]["date"] == out["date"] and len(sb) > 1:
        t0, t1 = sb[0], sb[1]
        pct = (t0["bal"] / t1["bal"] - 1) * 100 if t1["bal"] else 0
        add("借券賣出", "全市場借券賣出餘額", fmt(t0["bal"] - t1["bal"], 0, " 張"),
            f"餘額 {t0['bal']:,} 張（{pct:+.2f}%）；當日借券賣出 {t0['sell']:,} 張、還券 {t0['ret']:,} 張；餘額增加代表放空部位變多",
            -sgn(pct, SBL_TH_1D), "spot")
    else:
        add("借券賣出", "全市場借券賣出餘額", "尚未公布", "借券賣出餘額約晚上 9 點後公布", 0)
    # ---- 市場廣度 ----
    mb = out.get("market_breadth")
    if mb:
        tr = mb["trend"]
        today = tr[-1]
        net5 = sum(r["net"] for r in tr[-5:])
        div = ""
        if today["change"] and today["change"] > 0 and today["net"] < 0:
            div = "；指數漲但下跌家數較多（背離，可能只有權值股撐盤）"
        elif today["change"] and today["change"] < 0 and today["net"] > 0:
            div = "；指數跌但上漲家數較多（背離，可能是權值股拖累）"
        add("市場廣度", "騰落（上市＋上櫃）", fmt(today["net"], 0, " 家"),
            f"上漲 {today['up']:,}／下跌 {today['down']:,}；近 5 日合計 {fmt(net5)}" + div, sgn(today["net"], 200), "breadth")
        r20 = mb.get("ratio20")
        if r20:
            up = (mb["twse"]["change"] or 0) > 0
            vol = "放量" if r20 >= 1.2 else "量縮" if r20 <= 0.8 else "量平"
            bias = (1 if up else -1) if vol == "放量" else 0
            add("市場廣度", "量能", f"{r20:.2f} 倍（20 日）",
                f"上市成交 {mb['twse']['value']:,.0f} 億，{vol}{'上漲' if up else '下跌'}；5 日量比 {mb.get('ratio5') or 0:.2f} 倍", bias, "breadth")
        upl = mb["twse"]["up_limit"] + mb["tpex"]["up_limit"]
        dnl = mb["twse"]["down_limit"] + mb["tpex"]["down_limit"]
        add("市場廣度", "漲停／跌停家數", f"{upl}／{dnl}", "上市＋上櫃股票", sgn(upl - dnl, 9), "breadth")
        if mb.get("sectors"):
            top = mb["sectors"][:3]
            add("市場廣度", "資金集中類股", "、".join(x["name"] for x in top),
                "；".join(f"{x['name']} 占 {x['share']:.1f}%（{fmt(x['pct'], 2, '%')}）" for x in top), 0)
    # ---- 融資融券 ----
    if chips:
        tw = [c["margin"]["twse"]["fin_amt"] + c["margin"]["tpex"]["fin_amt"] for c in chips]
        chg = [a - b for a, b in zip(tw, tw[1:])]
        idx_up = (mb or {}).get("twse", {}).get("change", 0) > 0 if mb else None
        if chg:
            n = streak(chg)
            if chg[0] > 0 and idx_up is False:
                bias, note = -1, "指數下跌但融資增加（散戶逢低承接，籌碼較亂）"
            elif chg[0] < 0 and idx_up:
                bias, note = 1, "指數上漲且融資減少（籌碼較乾淨）"
            else:
                bias, note = 0, ""
            add("融資融券", "融資餘額（上市＋上櫃）", fmt(chg[0], 2, " 億"),
                "；".join(x for x in (f"餘額 {tw[0]:,.0f} 億", streak_text(n, "增加", "減少"),
                                      f"近 {len(chg)} 日 {fmt(sum(chg), 2, ' 億')}", note) if x), bias, "sentiment")
        m0 = chips[0]["margin"]["twse"]
        ratio = m0["short_lots"] / m0["fin_lots"] * 100 if m0["fin_lots"] else 0
        prev = chips[1]["margin"]["twse"] if len(chips) > 1 else None
        pr = prev["short_lots"] / prev["fin_lots"] * 100 if prev and prev["fin_lots"] else None
        add("融資融券", "券資比（上市）", f"{ratio:.2f}%",
            f"融券 {m0['short_lots']:,} 張／融資 {m0['fin_lots']:,} 張" + (f"；前一日 {pr:.2f}%" if pr is not None else ""), 0)
    elif chips_err:
        add("融資融券", "融資融券", "尚未公布", chips_err, 0)
    # ---- 期貨（期交所快照，新→舊） ----
    fut = out.get("fut")
    snaps = [json.loads(p.read_text()) for p in sorted(FUT_DIR.glob("*.json"), reverse=True)] if FUT_DIR.exists() else []
    if fut:
        snaps = [x for x in snaps if x["date"] <= fut["date"]]
        fi = next(r for r in fut["inst"] if r["name"] == "外資")
        d = fi.get("fut_d")
        n = streak([a["inst"]["fi"]["fut"] - b["inst"]["fi"]["fut"] for a, b in zip(snaps, snaps[1:])])
        add("期貨", "外資台指淨未平倉", fmt(fi["fut"], 0, " 口"),
            "；".join(x for x in (f"較前日 {fmt(d)} 口" if d is not None else "",
                                  streak_text(n, "淨多增加（空單回補）", "淨空增加"),) if x), sgn(d or 0, 1000), "fut")
        lg = next(r for r in fut["large"] if r["name"] == "台指")
        add("期貨", "十大特定法人台指近月", fmt(lg["sp_near"], 0, " 口"),
            f"較前日 {fmt(lg.get('sp_near_d'))} 口；其他月 {fmt(lg['sp_far'])} 口", sgn(lg.get("sp_near_d") or 0, 1000), "fut")
        net_amt = round(fi["call_amt"] - fi["put_amt"], 2)
        add("期貨", "外資選擇權（買權－賣權淨金額）", fmt(net_amt, 2, " 億"),
            f"買權 {fmt(fi['call_amt'], 2)} 億、賣權 {fmt(fi['put_amt'], 2)} 億（淨未平倉金額）", sgn(net_amt, 0.5), "fut")
        # 小台散戶多空比（反向指標）：比前幾日平均高 RETAIL_TH 個百分點以上偏空、低 RETAIL_TH 以上偏多
        rt = fut.get("retail")
        if rt and len(rt.get("trend") or []) >= 2:
            cur = next(x for x in rt["rows"] if x["code"] == "MTX")
            past = [t["MTX"] for t in rt["trend"][:-1] if t.get("MTX") is not None]
            if cur["ratio"] is not None and past:
                avg = sum(past) / len(past)
                add("期貨", "小台散戶多空比（反向）", f"{cur['ratio']:+.2f}%",
                    f"前 {len(past)} 日平均 {avg:+.2f}%；散戶淨部位 {fmt(cur['net'])} 口（較前日 {fmt(cur.get('net_d'))}）；散戶越偏多越視為偏空",
                    -sgn(cur["ratio"] - avg, RETAIL_TH), "sentiment")
        pc = fut.get("pc") or []
        if len(pc) >= 2:
            avg5 = sum(x["oi"] for x in pc[-6:-1]) / len(pc[-6:-1])
            cur = pc[-1]["oi"]
            add("選擇權", "全市場 P/C（未平倉）", f"{cur:.2f}%",
                f"前 5 日平均 {avg5:.2f}%；P/C 上升代表賣權（支撐）部位相對增加", sgn(cur - avg5, 5), "sentiment")
        o = fut.get("opt")
        if o and o["series"]:
            x = o["series"][0]
            ref = o["ref"]
            r1 = x["resist"][0]["strike"] if x["resist"] else None
            s1 = x["support"][0]["strike"] if x["support"] else None
            parts = []
            if r1:
                parts.append(f"壓力 {r1:,}（距 {r1 - ref:,.0f} 點）")
            if s1:
                parts.append(f"支撐 {s1:,}（距 {ref - s1:,.0f} 點）")
            add("選擇權", f"最近結算 {x['label']}", f"加權 {ref:,.0f}", "；".join(parts) or "指數附近無明顯未平倉", 0)

    # ================= 中期（看 20～60 日，資料取自趨勢） =================
    rows = (trend or {}).get("rows") or []
    if rows and rows[-1]["date"] == out["date"]:
        M = "mid"
        col = lambda k: [r.get(k) for r in rows]  # noqa: E731
        idx = col("index")
        last = idx[-1]
        for n_ma in (20, 60):
            w = [v for v in idx[-n_ma:] if v is not None]
            if len(w) == n_ma:
                ma = sum(w) / n_ma
                gap = (last / ma - 1) * 100
                add("指數位置", f"加權指數 vs {n_ma} 日均線", f"{gap:+.2f}%", f"{n_ma} 日均線 {ma:,.0f}；收盤 {last:,.2f}"
                    + ("，在均線之上" if gap > 0 else "，在均線之下"), sgn(gap), "position", M)
        fi20 = [v for v in col("fi")[-20:] if v is not None]
        if len(fi20) >= 18:
            tot = sum(fi20)
            add("現貨法人", "外資現貨 20 日累計（上市）", fmt(tot, 0, " 億"),
                f"近 {len(fi20)} 個有資料的交易日；平均每日 {fmt(tot / len(fi20), 0, ' 億')}", sgn(tot, FI20_TH), "spot", M)
        if len(sb) >= 6 and sb[0]["date"] == out["date"]:
            pct5 = (sb[0]["bal"] / sb[5]["bal"] - 1) * 100 if sb[5]["bal"] else 0
            add("借券賣出", "全市場借券賣出餘額 5 日變化", f"{pct5:+.2f}%",
                f"{sb[5]['date'][5:].replace('-', '/')} 起 {fmt(sb[0]['bal'] - sb[5]['bal'], 0, ' 張')}；增加代表放空部位變多", -sgn(pct5, SBL_TH_5D), "spot", M)

        def window(k):
            v = col(k)
            return v if v[-1] is not None and sum(x is not None for x in v) >= 40 else None

        def rng_text(v, p, unit="", d=0):
            w = [x for x in v if x is not None]
            return f"60 日區間 {min(w):,.{d}f}～{max(w):,.{d}f}{unit}，目前在第 {p} 百分位"

        v = window("fi_oi")
        if v:
            p = pct_rank(v, v[-1])
            d20 = v[-1] - v[-21] if v[-21] is not None else None
            add("期貨", "外資台指淨未平倉 60 日位置", fmt(v[-1], 0, " 口"),
                rng_text(v, p, " 口") + (f"；20 日變化 {fmt(d20)} 口" if d20 is not None else "") + "；接近區間高檔（淨空最少）偏多、低檔偏空",
                extreme(p, 1), "fut", M)
        adl, ix = col("adl"), idx
        if len(rows) > 20 and adl[-1] is not None and adl[-21] is not None and ix[-21] is not None:
            a20, i20 = adl[-1] - adl[-21], ix[-1] - ix[-21]
            if i20 > 0 and a20 < 0:
                b, note = -1, "指數上漲但多數股票下跌（背離，漲勢集中在少數權值股）"
            elif i20 < 0 and a20 > 0:
                b, note = 1, "指數下跌但多數股票上漲（背離，可能是權值股拖累）"
            else:
                b, note = sgn(a20), "與指數同方向"
            add("市場廣度", "騰落線 vs 指數（20 日）", fmt(a20, 0, " 家"), f"指數 20 日 {fmt(i20, 0)} 點；{note}", b, "breadth", M)
        for k, name, unit, d, high_is, why in (
                ("MTX", "小台散戶多空比 60 日位置（反向）", "%", 2, -1, "散戶極度偏多視為偏空、極度偏空視為偏多"),
                ("pc_oi", "P/C 比 60 日位置", "%", 2, 1, "P/C 高代表賣權（支撐）部位多，視為偏多"),
                ("fin_amt", "融資餘額 60 日位置（反向）", " 億", 0, -1, "融資在高檔代表槓桿偏高，視為偏空"),
                ("vix", "台指 VIX 60 日位置（反向）", "", 2, 1, "VIX 高代表市場恐慌、選擇權保費貴，反向視為偏多；過低代表過度安心，視為偏空")):
            v = window(k)
            if v:
                p = pct_rank(v, v[-1])
                extra = ""
                if k == "vix" and rows[-1].get("hv20") is not None:
                    extra = f"；20 日歷史波動率 {rows[-1]['hv20']:.2f}%（VIX {'高於' if v[-1] > rows[-1]['hv20'] else '低於'}實際波動 {abs(v[-1] - rows[-1]['hv20']):.2f} 個百分點）"
                add("情緒槓桿", name, f"{v[-1]:,.{d}f}{unit}", rng_text(v, p, unit, d) + extra + "；" + why, extreme(p, high_is), "sentiment", M)
    else:
        add("中期", "中期訊號", "尚無資料", "趨勢資料還沒更新到今天", 0, None, "mid")

    # ---- 判讀：先算各面向（面向內計分項目的加總正負），再看幾個面向同向 ----
    terms = {}
    for t, (tname, dims) in TERMS.items():
        ds = []
        for dk in dims:
            its = [i for i in items if i["term"] == t and i["dim"] == dk]
            if not its:
                continue
            s = sum(i["bias"] for i in its)
            ds.append({"key": dk, "name": DIMS[dk], "lean": sgn(s), "bull": sum(i["bias"] > 0 for i in its),
                       "bear": sum(i["bias"] < 0 for i in its), "n": len(its)})
        bull = sum(d["lean"] > 0 for d in ds)
        bear = sum(d["lean"] < 0 for d in ds)
        verdict = "資料不足" if len(ds) < 3 else "偏多" if bull - bear >= 2 else "偏空" if bear - bull >= 2 else "多空互見"
        terms[t] = {"name": tname, "verdict": verdict, "bull": bull, "bear": bear, "neutral": len(ds) - bull - bear, "dims": ds}
    return items, terms


def load(get_json, out, gap=3.0, wait_minutes=0, warn=print):
    """融資融券與法人金額（data/chips/）；還沒公布時，設 wait_minutes 就每 10 分鐘重試。回傳 (chips, 錯誤訊息)"""
    deadline = time.time() + 60 * wait_minutes
    while True:
        try:
            return load_chips(get_json, [date.fromisoformat(x) for x in out["inst_dates"]], gap), None
        except MarginNotReady as e:
            if time.time() + 600 < deadline:
                print(f"融資融券尚未公布，10 分鐘後重試：{e}")
                time.sleep(600)
                continue
            return None, str(e)
        except Exception as e:  # noqa: BLE001
            warn("籌碼資料未更新", e)
            return None, f"{type(e).__name__}: {e}"


def sbl_summary(day):
    """首頁卡片用：全市場借券賣出餘額變化與增加最多的 3 檔（普通股）"""
    import re
    fs = [f for f in sorted(SBL_DIR.glob("*.json"), reverse=True) if f.stem <= day.replace("-", "")] if SBL_DIR.exists() else []
    if len(fs) < 2 or fs[0].stem != day.replace("-", ""):
        return None
    a, b = json.loads(fs[0].read_text()), json.loads(fs[1].read_text())
    d1 = {c: v[2] - b[c][2] for c, v in a.items() if re.fullmatch(r"\d{4}", c) and c in b}
    top = sorted(d1, key=lambda c: -d1[c])[:3]
    t = sbl_totals(day)
    return {"date": day, "bal": t[0]["bal"], "chg": t[0]["bal"] - t[1]["bal"],
            "pct": round((t[0]["bal"] / t[1]["bal"] - 1) * 100, 2) if t[1]["bal"] else None,
            "top": [{"code": c, "name": a[c][0], "d1": d1[c]} for c in top if d1[c] > 0]}


def compose(out, chips, err, trend=None):
    items, terms = signals(out, chips, err, trend)
    s = terms["short"]
    return {"date": out["date"], "fut_date": (out.get("fut") or {}).get("date"),
            "chips_date": chips[0]["date"] if chips else None,
            "trend_date": (trend or {}).get("date"),
            "generated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
            "items": items, "terms": terms, "sbl": sbl_summary(out["date"]),
            # 舊欄位（短線，以面向計）：保留給歷史檔與舊版網頁
            "score": {"bull": s["bull"], "bear": s["bear"], "neutral": s["neutral"], "verdict": s["verdict"]}}
