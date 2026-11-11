"""一次性回測資料下載（只在 backtest 分支的 Actions 執行，不影響網站）。
每個交易日：外資買賣超（張）、收盤價、漲跌、融資今日／前日餘額、融券今日／前日餘額（張），
沿用網站主程式的抓取與解析函式。輸出 backtest/data.json.gz；抓不到的日子記在 errors，不補假資料。"""
import gzip, json, sys, time
from datetime import date, timedelta
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_data as fd
import fetch_screens as fs
import fetch_lending as fl

GAP = 3.0
start, end = date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2])
j = fd.get_json("https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json")
off = {r[0] for r in j["data"] if "開始交易" not in r[1] and "最後交易" not in r[1]}
days, errors, names = {}, {}, {}
d = start
while d <= end:
    if d.weekday() < 5 and d.isoformat() not in off:
        try:
            inst = fd.fetch_inst(d); time.sleep(GAP)
            if inst is None:
                raise RuntimeError("上市法人無資料（臨時休市？）")
            q = fs.fetch_twse_day(fd.get_json, d); time.sleep(GAP)
            if not q:
                raise RuntimeError("上市行情抓不到")
            q.update({c: v for c, v in fs.from_quotes(fd.fetch_tpex_quotes(d)).items() if c not in q}); time.sleep(GAP)
            m = fl.fetch_margin(fd.get_json, d, GAP); time.sleep(GAP)
            if not m:
                raise RuntimeError("融資融券抓不到")
            rec = {}
            for c, v in q.items():
                if not fd.is_common_stock(c):
                    continue
                fi = inst.get(c)
                mg = m.get(c)
                rec[c] = [None if fi is None else round(fi[0] / 1000), v[0], v[1], v[2],
                          *((mg[2], mg[3], mg[5], mg[6]) if mg else (None, None, None, None))]
                if mg:
                    names[c] = [mg[0], mg[1]]
            days[d.isoformat()] = rec
            print(f"{d} ok 股票 {len(rec)}", flush=True)
        except Exception as e:  # noqa: BLE001
            errors[d.isoformat()] = f"{type(e).__name__}: {e}"[:300]
            print(f"::warning title={d} 抓取失敗::{errors[d.isoformat()]}", flush=True)
    d += timedelta(days=1)
out = Path(__file__).resolve().parent / "data.json.gz"
out.write_bytes(gzip.compress(json.dumps({"fields": ["外資(張)", "收盤", "漲跌", "成交張數", "融資餘額", "融資前日", "融券餘額", "融券前日"],
                                          "days": days, "names": names, "errors": errors, "holidays": sorted(off)},
                                         ensure_ascii=False, separators=(",", ":")).encode()))
print(f"交易日 {len(days)}，失敗 {len(errors)}")
if errors:
    print("::error title=部分日期抓取失敗::" + "；".join(f"{k} {v}" for k, v in errors.items())[:1500])
