"""綜合訊號表：把現貨法人、市場廣度、融資融券、期貨、選擇權、權值股的資料，用固定規則轉成一行一行的訊號。

每條訊號都有 bias：+1 偏多、-1 偏空、0 中性（或只是資訊），最後統計各有幾項。規則都是固定門檻，
不是預測，也不構成投資建議。

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


def load_chips(get_json, trade_date, gap):
    """trade_date（含）往前 DAYS 個交易日；當天融資融券還沒出時丟 MarginNotReady"""
    CHIPS_DIR.mkdir(parents=True, exist_ok=True)
    out, d = [], trade_date
    for _ in range(25):
        if len(out) >= DAYS:
            break
        p = CHIPS_DIR / f"{d:%Y%m%d}.json"
        if p.exists():
            out.append(json.loads(p.read_text()))
        elif d.weekday() < 5:
            time.sleep(gap)
            rec = fetch_chips(get_json, d, gap)
            if rec:
                p.write_text(json.dumps(rec, ensure_ascii=False))
                out.append(rec)
            elif d == trade_date:
                raise MarginNotReady(f"{d} 三大法人金額尚未公布")
        d -= timedelta(days=1)
    for p in CHIPS_DIR.glob("*.json"):
        if out and p.stem < out[-1]["date"].replace("-", ""):
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


def signals(out, chips, chips_err):
    items = []

    def add(group, name, value, detail, bias):
        items.append({"group": group, "name": name, "value": value, "detail": detail, "bias": bias})

    # ---- 現貨法人（上市，億元） ----
    if chips:
        for key, label, th in (("fi", "外資現貨", 30), ("it", "投信現貨", 10), ("dl", "自營商現貨", None)):
            vals = [c["inst"][key] for c in chips]
            n = streak(vals)
            add("現貨法人", label, fmt(vals[0], 2, " 億"),
                "；".join(x for x in (streak_text(n), f"近 {len(vals)} 日累計 {fmt(sum(vals), 2, ' 億')}") if x),
                0 if th is None else sgn(vals[0], th))
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
            f"上漲 {today['up']:,}／下跌 {today['down']:,}；近 5 日合計 {fmt(net5)}" + div, sgn(today["net"], 200))
        r20 = mb.get("ratio20")
        if r20:
            up = (mb["twse"]["change"] or 0) > 0
            vol = "放量" if r20 >= 1.2 else "量縮" if r20 <= 0.8 else "量平"
            bias = (1 if up else -1) if vol == "放量" else 0
            add("市場廣度", "量能", f"{r20:.2f} 倍（20 日）",
                f"上市成交 {mb['twse']['value']:,.0f} 億，{vol}{'上漲' if up else '下跌'}；5 日量比 {mb.get('ratio5') or 0:.2f} 倍", bias)
        upl = mb["twse"]["up_limit"] + mb["tpex"]["up_limit"]
        dnl = mb["twse"]["down_limit"] + mb["tpex"]["down_limit"]
        add("市場廣度", "漲停／跌停家數", f"{upl}／{dnl}", "上市＋上櫃股票", sgn(upl - dnl, 9))
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
                                      f"近 {len(chg)} 日 {fmt(sum(chg), 2, ' 億')}", note) if x), bias)
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
        snaps = [s for s in snaps if s["date"] <= fut["date"]]
        fi = next(r for r in fut["inst"] if r["name"] == "外資")
        d = fi.get("fut_d")
        n = streak([a["inst"]["fi"]["fut"] - b["inst"]["fi"]["fut"] for a, b in zip(snaps, snaps[1:])])
        add("期貨", "外資台指淨未平倉", fmt(fi["fut"], 0, " 口"),
            "；".join(x for x in (f"較前日 {fmt(d)} 口" if d is not None else "",
                                  streak_text(n, "淨多增加（空單回補）", "淨空增加"),) if x), sgn(d or 0, 1000))
        lg = next(r for r in fut["large"] if r["name"] == "台指")
        add("期貨", "十大特定法人台指近月", fmt(lg["sp_near"], 0, " 口"),
            f"較前日 {fmt(lg.get('sp_near_d'))} 口；其他月 {fmt(lg['sp_far'])} 口", sgn(lg.get("sp_near_d") or 0, 1000))
        net_amt = round(fi["call_amt"] - fi["put_amt"], 2)
        add("期貨", "外資選擇權（買權－賣權淨金額）", fmt(net_amt, 2, " 億"),
            f"買權 {fmt(fi['call_amt'], 2)} 億、賣權 {fmt(fi['put_amt'], 2)} 億（淨未平倉金額）", sgn(net_amt, 0.5))
        # ---- 選擇權 ----
        pc = fut.get("pc") or []
        if len(pc) >= 2:
            avg5 = sum(x["oi"] for x in pc[-6:-1]) / len(pc[-6:-1])
            cur = pc[-1]["oi"]
            add("選擇權", "全市場 P/C（未平倉）", f"{cur:.2f}%",
                f"前 5 日平均 {avg5:.2f}%；P/C 上升代表賣權（支撐）部位相對增加", sgn(cur - avg5, 5))
        o = fut.get("opt")
        if o and o["series"]:
            s = o["series"][0]
            ref = o["ref"]
            r1 = s["resist"][0]["strike"] if s["resist"] else None
            s1 = s["support"][0]["strike"] if s["support"] else None
            parts = []
            if r1:
                parts.append(f"壓力 {r1:,}（距 {r1 - ref:,.0f} 點）")
            if s1:
                parts.append(f"支撐 {s1:,}（距 {ref - s1:,.0f} 點）")
            add("選擇權", f"最近結算 {s['label']}", f"加權 {ref:,.0f}", "；".join(parts) or "指數附近無明顯未平倉", 0)
    # ---- 權值股與類股 ----
    tsmc = next((r for r in out.get("cap", []) if r["code"] == "2330"), None)
    if tsmc:
        add("權值股", "台積電外資", fmt(tsmc["fi_today"], 0, " 張"),
            f"近 10 日 {fmt(tsmc['fi_10d'])} 張；收盤 {tsmc['close']:,.0f}（{fmt(tsmc['pct'], 2, '%')}）", sgn(tsmc["fi_today"], 1000))
    cap = out.get("cap", [])
    if cap:
        tot = sum(r["fi_today"] for r in cap)
        n_buy = sum(1 for r in cap if r["fi_today"] > 0)
        add("權值股", "前 20 大權值股外資合計", fmt(tot, 0, " 張"), f"外資買超 {n_buy} 檔、賣超 {len(cap) - n_buy} 檔", sgn(tot, 5000))
    if mb and mb.get("sectors"):
        top = mb["sectors"][:3]
        add("權值股", "資金集中類股", "、".join(s["name"] for s in top),
            "；".join(f"{s['name']} 占 {s['share']:.1f}%（{fmt(s['pct'], 2, '%')}）" for s in top), 0)

    bull = sum(1 for i in items if i["bias"] > 0)
    bear = sum(1 for i in items if i["bias"] < 0)
    neutral = len(items) - bull - bear
    verdict = "偏多" if bull - bear >= 3 else "偏空" if bear - bull >= 3 else "多空互見"
    return items, {"bull": bull, "bear": bear, "neutral": neutral, "verdict": verdict}


def build(get_json, out, gap=3.0, wait_minutes=0, warn=print):
    """回傳 out["signals"]；融資融券還沒公布時，設 wait_minutes 就每 10 分鐘重試"""
    trade_date = date.fromisoformat(out["date"])
    deadline = time.time() + 60 * wait_minutes
    chips, err = None, None
    while True:
        try:
            chips = load_chips(get_json, trade_date, gap)
            break
        except MarginNotReady as e:
            if time.time() + 600 < deadline:
                print(f"融資融券尚未公布，10 分鐘後重試：{e}")
                time.sleep(600)
                continue
            err = str(e)
            break
        except Exception as e:  # noqa: BLE001
            warn("籌碼資料未更新", e)
            err = f"{type(e).__name__}: {e}"
            break
    items, score = signals(out, chips, err)
    return {"date": out["date"], "fut_date": (out.get("fut") or {}).get("date"),
            "chips_date": chips[0]["date"] if chips else None,
            "generated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
            "items": items, "score": score}
