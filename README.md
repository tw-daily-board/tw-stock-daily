# 台股盤後速覽

每個交易日盤後自動更新的靜態網站（GitHub Pages）：

1. 台股前 20 大權值股（收盤價×已發行普通股數）
2. 當日成交量前 20 大個股（排除 ETF）
3. 當日成交量前 15 大 ETF

欄位：市場（上市/上櫃）、收盤價、漲跌、漲跌幅、成交量(張)、成交金額(億)、三大法人買賣超（外資／投信／自營商分項，或合計；各含當日／前日／10 日合計，張）。

## 架構
- `scripts/fetch_data.py`：抓證交所公開資料 → `data/latest.json`（只用標準函式庫）
- `data/inst/`：每日三大法人快取，之後每天只抓新的一天
- `index.html` / `app.js` / `style.css`：純前端，讀 `data/latest.json`
- `.github/workflows/daily.yml`：週一~五 17:30 更新並部署，19:30 重試

## 上線
1. 推到 GitHub，Settings → Pages → Source 選 **GitHub Actions**
2. Actions → daily-update → Run workflow（第一次會抓 10 天法人資料，約 1 分鐘）

## 本機測試
    python3 scripts/fetch_data.py && python3 -m http.server   # 開 http://localhost:8000

## 限制
- 上市（TWSE）＋上櫃（TPEx）；不含興櫃
- 外資＝外陸資＋外資自營商；自營商＝自行買賣＋避險
- 上櫃資料來自櫃買中心新版網站 JSON，腳本會檢查欄位並驗證「外資+投信+自營商=合計」，格式改版時會直接報錯而不是產出錯誤數字
- 法人資料未公布時腳本會報錯，由 19:30 的重試補上
- 權值股占比以該股所屬市場（上市或上櫃）為分母
