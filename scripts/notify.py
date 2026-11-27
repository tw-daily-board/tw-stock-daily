"""Telegram 推送：盤前（07:50）、期貨（15:30）、綜合訊號＋融資摘要（21:00 資料更新後）。

只讀網站已產生的資料檔（data/pre.json、data/latest.json、data/margin.json、data/chips、data/combo.json），不另外連線抓資料、不用 LLM。
金鑰放在 GitHub Secrets（TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID），由 workflow 以環境變數傳入，不寫進任何檔案。
資料不是今天的就不推送（只印警告），避免把舊資料當成今天的發出去。

用法：python scripts/notify.py pre|fut|margin [--dry-run] [--test]
  --dry-run：只印出訊息、不送出，也不等到推送時間
  --test：設定確認用（telegram-test.yml）：用現有資料、加上「測試」標題立刻送出，不檢查日期、不等時間
"""
import html
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE = "https://tw-daily-board.github.io/tw-stock-daily/"
TW = timezone(timedelta(hours=8))
SEND_AT = {"pre": (7, 50), "fut": (15, 30), "margin": (21, 0)}   # 資料比這個時間早好，就等到這個時間再推
WEEK = "一二三四五六日"
TOP = 5


def load(name):
    return json.loads((DATA / name).read_text())


def esc(s):
    return html.escape(str(s), quote=False)


def num(v, d=0):
    return "-" if v is None else f"{v:,.{d}f}"


def sg(v, d=0):
    return "-" if v is None else ("+" if v > 0 else "") + f"{v:,.{d}f}"


def mark(v):
    """台股慣例：漲紅跌綠"""
    return "🔴" if v and v > 0 else "🟢" if v and v < 0 else "⚪"


def mdw(s):
    d = date.fromisoformat(s)
    return f"{d.month}/{d.day}（{WEEK[d.weekday()]}）"


def net_lots(v):
    return f"淨買 {num(v)} 口" if v > 0 else f"淨賣 {num(-v)} 口" if v < 0 else "買賣相當"


# ---------- 盤前 ----------
def msg_pre(today):
    p = load("pre.json")
    if p["date"] != today:
        raise Stale(f"盤前資料是 {p['date']}，不是 {today}")
    L = [f"🌅 <b>台股盤前速覽 {mdw(p['date'])}</b>", ""]
    sess = f"{mdw(p['night_from'])} 15:00～05:00" if p.get("night_from") else "前一晚"
    L.append(f"<b>【期貨夜盤】</b>{esc(sess)}")
    for r in p["night"]:
        L.append(f"{mark(r['change'])} {esc(r['name'])} {num(r['close'], 2 if r['close'] % 1 else 0)}　{sg(r['change'], 2 if r['close'] % 1 else 0)}（{sg(r['pct'], 2)}%）")
    ni = p.get("night_inst")
    if ni:
        f = {r["name"]: r for r in ni["fut"]}
        o = {r["name"]: r for r in ni["opt"]}
        L += ["", "<b>【夜盤三大法人】</b>交易口數（夜盤沒有未平倉）",
              "台指期　" + "｜".join(f"{k} {sg(f[k]['net'])}" for k in ("外資", "投信", "自營商")),
              f"外資選擇權　Call {net_lots(o['外資']['call_net'])}、Put {net_lots(o['外資']['put_net'])}"]
    else:
        L += ["", "<b>【夜盤三大法人】</b>尚未公布"]
    w = p.get("world")
    if w:
        pick = {x["sym"]: x for x in w["markets"]}
        rows = [pick.get(s) for s in ("^DJI", "^GSPC", "^IXIC", "^SOX", "^N225", "^KS11")]
        L += ["", "<b>【國際市場】</b>"]
        L += [f"{mark(x['pct'])} {esc(x['name'])} {num(x['close'], 2)}（{sg(x['pct'], 2)}%）" for x in rows if x and x.get("close") is not None]
        a = w.get("adr")
        if a and a.get("close") is not None:
            prem = f"，溢價 {sg(a['premium'], 2)}%" if a.get("premium") is not None else ""
            L.append(f"{mark(a['pct'])} 台積電 ADR {num(a['close'], 2)}（{sg(a['pct'], 2)}%）{prem}")
    e = p["events"]
    ex = [x for x in e["exright"] if x["d"] == p["date"]]
    L += ["", "<b>【今日】</b>",
          "選擇權結算：" + ("、".join(esc(x) for x in e["settle"]) if e["settle"] else "無"),
          f"除權息：{len(ex)} 檔" + (f"（{'、'.join(esc(x['name']) for x in ex[:8])}{' 等' if len(ex) > 8 else ''}）" if ex else ""),
          f"處置中：{len(e['flags'].get('處置', []))} 檔"]
    L += ["", f'<a href="{SITE}#pre">看完整盤前速覽</a>']
    return "\n".join(L)


# ---------- 期貨 ----------
def msg_fut(today):
    f = load("latest.json")["fut"]
    if f["date"] != today:
        raise Stale(f"期貨資料是 {f['date']}，不是 {today}")
    ix = f["index"]
    L = [f"📈 <b>台指期盤後 {mdw(f['date'])}</b>", "",
         f"{mark(ix['change'])} 加權指數 {num(ix['close'], 2)}　{sg(ix['change'], 2)}（{sg(ix['pct'], 2)}%），成交 {num(ix['value_tril'] * 10000, 0)} 億"]
    near = f["market"][0]
    L.append(f"{mark(near['change'])} {esc(near['name'])} {num(near['close'])}　{sg(near['change'])}（{sg(near['pct'], 2)}%），未平倉 {num(near['oi'])}（{sg(near['oi_chg'])}）")
    L += ["", "<b>【三大法人】</b>現貨（億）｜台指期淨未平倉（口，較前日）"]
    for r in f["inst"]:
        L.append(f"{esc(r['name'])}　{sg(r['cash'], 2)}｜{sg(r['fut'])}（{sg(r['fut_d'])}）")
    fi = next(r for r in f["inst"] if r["name"] == "外資")
    L.append(f"外資選擇權淨未平倉　Call {sg(fi['call'])} 口（{sg(fi['call_d'])}）、Put {sg(fi['put'])} 口（{sg(fi['put_d'])}）")
    rt = next((r for r in (f.get("retail") or {}).get("rows", []) if r["code"] == "MTX"), None)
    pc = (f.get("pc") or [None])[-1]
    extra = []
    if rt:
        extra.append(f"小台散戶多空比 {sg(rt['ratio'], 2)}%（{sg(rt['ratio_d'], 2)}）")
    if pc and pc.get("date") == f["date"]:
        extra.append(f"P/C 未平倉比 {num(pc['oi'], 2)}%")
    if extra:
        L += ["", "<b>【情緒】</b>" + "；".join(extra)]
    s = (f.get("opt") or {}).get("series") or []
    if s:
        s = s[0]
        top = lambda xs: "、".join(f"{num(x['strike'])}（{num(x['oi'])}）" for x in xs[:2]) or "無"  # noqa: E731
        L += ["", f"<b>【選擇權支撐壓力】</b>{esc(s['label'])}",
              f"壓力（Call 未平倉最多）：{top(s['resist'])}", f"支撐（Put 未平倉最多）：{top(s['support'])}"]
    b = f.get("build")
    if b and b.get("series"):
        x = b["series"][0]
        rg = x.get("range") or {}
        lo, hi = rg.get("put"), rg.get("call")
        if lo and hi:
            txt = f"{num(lo['strike'])}～{num(hi['strike'])}"
        elif lo:
            txt = f"下緣 {num(lo['strike'])}（Call 側沒有偏賣方部位，上緣無法推測）"
        elif hi:
            txt = f"上緣 {num(hi['strike'])}（Put 側沒有偏賣方部位，下緣無法推測）"
        else:
            txt = "沒有足夠的偏賣方部位，無法推測"
        L += ["", f"<b>【建倉推測】</b>⚠️推測，非官方　{esc(x['label'])} 賣方區間：{txt}"]
    L += ["", f'<a href="{SITE}#fut">看完整台指期</a>　<a href="{SITE}#ob">看選擇權建倉</a>']
    return "\n".join(L)


# ---------- 綜合訊號＋融資摘要（21:00） ----------
LEAN = {1: "🔴偏多", -1: "🟢偏空", 0: "⚪中性"}   # 台股慣例：紅多綠空
DOT = {1: "🔴", -1: "🟢", 0: "⚪"}


def msg_margin(today):
    s = load("latest.json").get("signals") or {}
    if s.get("date") != today:
        raise Stale(f"綜合訊號資料是 {s.get('date')}，不是 {today}")
    L = [f"🧭 <b>綜合訊號 {mdw(s['date'])}</b>", ""]
    for key in ("short", "mid"):
        t = s["terms"][key]
        L.append(f"<b>【{t['name']}】{t['verdict']}</b>（偏多 {t['bull']}／偏空 {t['bear']}／中性 {t['neutral']} 個面向）")
        L += [f"　{LEAN[d['lean']]} {esc(d['name'])}（多 {d['bull']}・空 {d['bear']}／{d['n']} 項）" for d in t["dims"]]
        L.append("")
    L.append("<b>【關鍵指標】</b>")
    for key, title in (("short", "短線"), ("mid", "中期")):
        rows = [i for i in s["items"] if i["term"] == key and (i["bias"] != 0 or not i["scored"])]
        if not rows:
            continue
        L.append(f"‧{title}")
        for i in rows:
            extra = ""
            if i["group"] in ("期貨", "選擇權") or i["name"] == "外資現貨":
                d = i["detail"] if i["name"].startswith("最近結算") else i["detail"].split("；")[0]
                extra = "｜" + esc(d.replace("（淨未平倉金額）", ""))
            L.append(f"{DOT[i['bias']] if i['scored'] else 'ℹ️'} {esc(i['name'])}：{esc(i['value'])}{extra}")
    L += ["", "<b>【融資摘要】</b>"] + margin_brief(today)
    L += ["", "🔴偏多 🟢偏空 ⚪中性 ℹ️參考（不計分）；固定規則計算，非投資建議",
          f'<a href="{SITE}">看完整綜合訊號</a>　<a href="{SITE}#mgn">看融資融券</a>　<a href="{SITE}#scr">看籌碼篩選</a>']
    return "\n".join(L)


def margin_brief(today):
    """融資重點 3～4 行；資料不是今天的就註明，不讓整則推送失敗。"""
    out = []
    files = sorted((DATA / "chips").glob("*.json"))
    cur = json.loads(files[-1].read_text()) if files else None
    prev = json.loads(files[-2].read_text()) if len(files) > 1 else None
    if cur and cur["date"] == today:
        parts = []
        for k, label in (("twse", "上市"), ("tpex", "上櫃")):
            c, p = cur["margin"][k], (prev or {}).get("margin", {}).get(k)
            parts.append(f"{label} {num(c['fin_amt'], 2)} 億（{sg(c['fin_amt'] - p['fin_amt'] if p else None, 2)}）")
        out.append("融資餘額：" + "、".join(parts))
    try:
        m = load("margin.json")
    except (OSError, ValueError):
        m = None
    if m and m.get("date") == today:
        stocks = [r for r in m["rows"] if not r["etf"] and r.get("fin_d1") is not None]
        def top(rev):
            xs = sorted((r for r in stocks if (r["fin_d1"] > 0 if rev else r["fin_d1"] < 0)),
                        key=lambda r: r["fin_d1"], reverse=rev)[:3]
            return "、".join(f"{esc(r['name'])} {sg(r['fin_d1'])}" for r in xs) or "無"
        out.append(f"融資增加：{top(True)}（張）")
        out.append(f"融資減少：{top(False)}（張）")
    try:
        c = load("combo.json")
    except (OSError, ValueError):
        c = None
    if c and c.get("rows") is not None and c.get("date") == today:
        hit = [r for r in c["rows"] if all(v is not None and v > 0 for v in r["mom"])]
        names = "、".join(f"{esc(r['name'])}（約 {num(r['mr'], 0)}%）" for r in hit[:5]) or "無"
        out.append(f"董監融資篩選 {len(hit)} 檔：{names}（維持率為估算）")
    return out or ["今天的融資資料尚未產生"]


class Stale(Exception):
    pass


BUILD = {"pre": msg_pre, "fut": msg_fut, "margin": msg_margin}


def send(token, chat, text):
    body = urllib.parse.urlencode({"chat_id": chat, "text": text, "parse_mode": "HTML",
                                   "disable_web_page_preview": "true"}).encode()
    last = None
    for i in range(3):
        try:
            with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", body, timeout=30) as r:
                j = json.loads(r.read())
            if j.get("ok"):
                return
            last = RuntimeError(f"Telegram 回應錯誤：{j.get('description')}")
        except urllib.error.HTTPError as e:   # 不印網址（含金鑰），只印狀態與說明
            last = RuntimeError(f"Telegram HTTP {e.code}：{e.read().decode(errors='replace')[:200]}")
        except OSError as e:
            last = RuntimeError(f"連不上 Telegram：{type(e).__name__}")
        time.sleep(10 * (i + 1))
    raise last


def main():
    slot, dry, test = sys.argv[1], "--dry-run" in sys.argv, "--test" in sys.argv
    now = datetime.now(TW)
    today = now.date().isoformat()
    if test:
        data_date = {"pre": lambda: load("pre.json")["date"], "fut": lambda: load("latest.json")["fut"]["date"],
                     "margin": lambda: load("margin.json")["date"]}[slot]()
        text = "🧪 <b>測試訊息</b>（確認聊天室設定，內容為網站目前的資料）\n\n" + BUILD[slot](data_date)
    else:
        try:
            text = BUILD[slot](today)
        except Stale as e:
            print(f"::warning title=Telegram 未推送（{slot}）::{e}")
            return
    if dry:
        print(text)
        return
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        if test:   # 測試就是要確認設定：沒設定直接失敗
            print("::error title=Telegram 未設定::GitHub Secrets 沒有 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID")
            sys.exit(1)
        print("::warning title=Telegram 未設定::沒有 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，略過推送")
        return
    h, mi = SEND_AT[slot]
    wait = 0 if test else (now.replace(hour=h, minute=mi, second=0, microsecond=0) - now).total_seconds()
    if wait > 0:
        print(f"等到 {h:02d}:{mi:02d} 再推送（{int(wait)} 秒）")
        time.sleep(wait)
    try:
        send(token, chat, text)
    except Exception as e:  # noqa: BLE001
        print(f"::error title=Telegram 推送失敗（{slot}）::{e}")
        sys.exit(1)
    print(f"已推送 Telegram（{slot}）")


if __name__ == "__main__":
    main()
