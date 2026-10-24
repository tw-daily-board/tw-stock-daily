const BASE = [
  { k: "rank",   t: "#" },
  { k: "code",   t: "代號" },
  { k: "name",   t: "名稱" },
  { k: "market", t: "市場" },
  { k: "close",  t: "收盤價", f: v => v.toFixed(2) },
  { k: "change", t: "漲跌", f: v => signed(v.toFixed(2), v), c: true },
  { k: "pct",    t: "漲跌幅", f: v => signed(v.toFixed(2) + "%", v), c: true },
  { k: "volume", t: "成交量(張)", f: v => v.toLocaleString() },
  { k: "value",  t: "成交金額(億)", f: v => (v / 1e8).toFixed(2) },
];
const CAP_EXTRA = [
  { k: "mktcap", t: "市值(億)", f: v => v.toLocaleString() },
  { k: "weight", t: "占該市場", f: v => v.toFixed(2) + "%" },
];
// 法人欄位：[前綴, 群組名稱]；每組 當日 / 前日 / 10日合計（單位：張）
// 法人欄位一次只顯示一組（外資／投信／自營商／合計），表格才不會寬到要橫向捲動
const INST_VIEWS = { fi: ["fi", "外資"], it: ["it", "投信"], dl: ["dl", "自營商"], inst: ["inst", "三大法人合計"] };
const INST_SUB = [["today", "當日"], ["prev", "前日"], ["10d", "10日合計"]];
function signed(s, v) { return v > 0 ? "+" + s : s; }
function n(v) { return v == null ? "-" : signed(v.toLocaleString(), v); }
const cls = v => (v > 0 ? "up" : v < 0 ? "down" : "");

// 外資買賣超分頁：買超、賣超兩張表，各自一組「外資及陸資」當日 / 前日 / 10日合計
const FI_SECTIONS = {
  fi: [["fi_buy", "外資買超前20大（個股）", "fi_total"], ["fi_sell", "外資賣超前20大（個股）", "fi_total"]],
  fi_etf: [["fi_etf_buy", "外資買超前20大（ETF）", "fi_etf_total"], ["fi_etf_sell", "外資賣超前20大（ETF）", "fi_etf_total"]],
};
const isFi = t => t in FI_SECTIONS;

// 代號／名稱點下去開個股頁（新分頁）；網站可在右上角切換，記在瀏覽器裡
const SITES = {
  yahoo: ["Yahoo 股市", c => `https://tw.stock.yahoo.com/quote/${c}`],
  cnyes: ["鉅亨網", c => `https://www.cnyes.com/twstock/${c}`],
  goodinfo: ["Goodinfo", c => `https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${c}`],
  wantgoo: ["玩股網", c => `https://www.wantgoo.com/stock/${c}`],
};
let site = "yahoo";
try { const v = localStorage.getItem("site"); if (v in SITES) site = v; } catch (e) { /* 無痕模式等情況下略過 */ }
const stockLink = (code, txt) => `<a class="sl" href="${SITES[site][1](encodeURIComponent(code))}" target="_blank" rel="noopener noreferrer">${txt}</a>`;

let data = null, tab = "cap", view = "fi", sort = null;

function cols() {
  if (isFi(tab)) {
    const c = BASE.slice();
    c.push({ k: "fi_amt", t: "當日金額(億)", f: v => n(v.toFixed(2)), c: true, g: "外資及陸資", first: true });
    for (const [s, t] of INST_SUB) c.push({ k: `fi_${s}`, t, f: n, c: true, g: "外資及陸資" });
    return c;
  }
  const c = BASE.slice();
  if (tab === "cap") c.splice(9, 0, ...CAP_EXTRA);
  const [p, g] = INST_VIEWS[view];
  for (const [s, t] of INST_SUB) c.push({ k: `${p}_${s}`, t, f: n, c: true, g, first: s === "today" });
  return c;
}

function tableHtml(key, rows, cs, total) {
  if (sort?.sec === key) {
    const { k, dir } = sort;
    rows = rows.slice().sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k]) : (a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir);
  }
  const plain = cs.filter(c => !c.g).length;
  const grps = isFi(tab) ? [["fi", "外資及陸資"]] : [INST_VIEWS[view]];
  const groupRow = "<tr>" + `<th class="plain" colspan="${plain}"></th>` +
    grps.map(([p, g]) => `<th class="grp" colspan="${cs.filter(c => c.g === g).length}">${g}（張）</th>`).join("") + "</tr>";
  const th = c => `<th data-k="${c.k}" data-sec="${key}" class="${c.first ? "gl " : ""}${sort?.sec === key && sort.k === c.k ? (sort.dir > 0 ? "asc" : "desc") : ""}">${c.t}</th>`;
  const cell = (c, r) => {
    const v = r[c.k];
    let txt = c.f ? (v == null ? "-" : c.f(v)) : v;
    if (c.k === "code" || c.k === "name") txt = stockLink(r.code, txt);
    const klass = [c.c ? cls(v) : "", c.k === "name" ? "name" : "", c.first ? "gl" : ""].join(" ");
    return `<td class="${klass}">${txt}</td>`;
  };
  const body = rows.map(r => "<tr>" + cs.map(c => cell(c, r)).join("") + "</tr>").join("");
  const foot = (total || []).map(([label, r]) => {
    const lead = `<td colspan="${plain}" class="name">${label}</td>`;
    return "<tr class=\"tot\">" + lead + cs.filter(c => c.g).map(c => cell(c, r)).join("") + "</tr>";
  }).join("");
  // 外資分頁有上下兩張表，固定欄寬讓兩表對齊
  const widths = [40, 80, 170, 64];
  const colgroup = isFi(tab) ? "<colgroup>" + cs.map((c, i) => `<col style="width:${widths[i] ?? 110}px">`).join("") + "</colgroup>" : "";
  return `<table class="${isFi(tab) ? "fx" : ""}">${colgroup}<thead>${groupRow}<tr>${cs.map(th).join("")}</tr></thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}</table>`;
}

function sumOf(rows) {
  const r = { fi_amt: 0 };
  for (const k of ["fi_today", "fi_prev", "fi_10d"]) r[k] = rows.reduce((a, x) => a + (x[k] ?? 0), 0);
  r.fi_amt = Math.round(rows.reduce((a, x) => a + x.fi_amt, 0) * 100) / 100;
  return r;
}

// ---- 台指期盤後快訊：收盤行情表、三大法人籌碼變化、十大交易人期權淨部位 ----
const num = (v, d = 0) => v == null ? "-" : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const sg = (v, d = 0) => v == null ? "-" : signed(num(v, d), v);
// 數值（上）＋ 與前一交易日的變化（下，括號）
const vd = (v, dv, d = 0) => `<span class="${cls(v)}">${sg(v, d)}</span>` + (dv == null ? "" : `<span class="dv ${cls(dv)}">(${sg(dv, d)})</span>`);
const ftable = (title, head, rows, extra = "") =>
  `<h2 class="sec">${title}</h2><div class="sc"><table class="ft"><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>${extra}</div>`;

// 選擇權支撐壓力：最近到期的幾個系列，可切換
let optSel = 0;
function renderOpt(o, pc, date) {
  if (!o || !o.series.length) return '<div class="empty">選擇權資料尚未公布，之後排程會自動補上。</div>';
  const s = o.series[Math.min(optSel, o.series.length - 1)];
  const tabs = o.series.map((x, i) => `<button data-opt="${i}" class="${x === s ? "on" : ""}">${x.label}</button>`).join("");
  const lst = (arr, side) => arr.length ? arr.map(x =>
    `<li><b>${num(x.strike)}</b><span>${num(x.oi)} 口</span><span class="${cls(x.d)}">${x.d == null ? "" : `(${sg(x.d)})`}</span></li>`).join("")
    : `<li class="mute">指數${side}${Math.round(o.sr_range * 100)}% 內無未平倉</li>`;
  const max = Math.max(1, ...s.rows.map(r => Math.max(r[1], r[2])));
  const hot = new Set([...s.resist, ...s.support].map(x => x.strike));
  const lab = new Set([...s.resist.map(x => "c" + x.strike), ...s.support.map(x => "p" + x.strike)]);
  const tip = r => `履約價 ${num(r[0])}｜買權 ${num(r[1])} 口${r[3] == null ? "" : `（${sg(r[3])}）`}｜賣權 ${num(r[2])} 口${r[4] == null ? "" : `（${sg(r[4])}）`}`;
  let marked = false;
  const rows = s.rows.slice().reverse().map(r => {
    let mark = "";
    if (!marked && r[0] <= o.ref) { marked = true; mark = `<div class="ix"><span>加權 ${num(o.ref, 2)}</span></div>`; }
    return mark + `<div class="br${hot.has(r[0]) ? " hot" : ""}" title="${tip(r)}">` +
      `<div class="pl">${lab.has("p" + r[0]) ? `<em>${num(r[2])}</em>` : ""}<i class="put" style="width:${r[2] / max * 100}%"></i></div>` +
      `<div class="k">${num(r[0])}</div>` +
      `<div class="cl"><i class="call" style="width:${r[1] / max * 100}%"></i>${lab.has("c" + r[0]) ? `<em>${num(r[1])}</em>` : ""}</div></div>`;
  }).join("");
  const tbl = `<details class="tv"><summary>以表格檢視</summary><table class="ft"><thead><tr><th>履約價</th><th>買權 OI</th><th>變化</th><th>賣權 OI</th><th>變化</th></tr></thead><tbody>` +
    s.rows.map(r => `<tr><td>${num(r[0])}</td><td>${num(r[1])}</td><td class="${cls(r[3])}">${sg(r[3])}</td><td>${num(r[2])}</td><td class="${cls(r[4])}">${sg(r[4])}</td></tr>`).join("") + "</tbody></table></details>";
  const pcRows = (pc || []).slice().reverse().map(x => `<tr><td>${x.date}</td><td>${num(x.oi, 2)}%</td><td>${num(x.vol, 2)}%</td></tr>`).join("");
  return `<h2 class="sec">選擇權支撐壓力（臺指選擇權，${date}）</h2><div class="sc opt">
    <nav class="optnav">${tabs}</nav>
    <div class="sr">
      <div><h3>壓力：指數以上買權未平倉最大</h3><ol>${lst(s.resist, "以上")}</ol></div>
      <div><h3>支撐：指數以下賣權未平倉最大</h3><ol>${lst(s.support, "以下")}</ol></div>
      <div><h3>此系列 P/C（未平倉）</h3><p class="big">${s.pc == null ? "-" : num(s.pc, 1) + "%"}</p><p class="mute">買權 ${num(s.call_oi)} 口・賣權 ${num(s.put_oi)} 口</p></div>
    </div>
    <div class="lg"><span><i class="put"></i>賣權未平倉（支撐）</span><span><i class="call"></i>買權未平倉（壓力）</span><span class="mute">加權指數上下 ${Math.round(o.chart_range * 100)}%；滑鼠移到列上看口數與變化</span></div>
    <div class="bf">${rows}</div>${tbl}
    <p class="fn">支撐壓力在加權指數上下 ${Math.round(o.sr_range * 100)}% 內找，排除遠價外舊倉；括號為較前一交易日的未平倉變化。週選分週三（W）與週五（F）到期，月選於每月第三個週三結算。</p>
    ${pcRows ? `<h3 class="pch">全市場 P/C 比（近 10 日）</h3><table class="ft pc"><thead><tr><th>日期</th><th>未平倉</th><th>成交量</th></tr></thead><tbody>${pcRows}</tbody></table>` : ""}
  </div>`;
}

// ---- 市場整體強弱：指數與量能、漲跌家數、近 10 日騰落、類股資金 ----
function breadthCard(title, m) {
  const tot = m.up + m.down + m.flat || 1;
  return `<div><h3>${title}</h3>
    <p class="bd"><span class="up">上漲 ${num(m.up)}<small>（漲停 ${m.up_limit}）</small></span><span class="mute2">平盤 ${num(m.flat)}</span><span class="down">下跌 ${num(m.down)}<small>（跌停 ${m.down_limit}）</small></span></p>
    <div class="ratio" title="上漲 ${num(m.up / tot * 100, 1)}%・平盤 ${num(m.flat / tot * 100, 1)}%・下跌 ${num(m.down / tot * 100, 1)}%"><i class="u" style="width:${m.up / tot * 100}%"></i><i class="f" style="width:${m.flat / tot * 100}%"></i><i class="d" style="width:${m.down / tot * 100}%"></i></div>
    <p class="mute">上漲占 ${num(m.up / tot * 100, 1)}%</p></div>`;
}

function renderMarket(m) {
  if (!m) return '<div class="empty">市場強弱資料尚未產生，之後排程會自動補上。</div>';
  const pct = (c, i) => c == null || i == null ? null : c / (i - c) * 100;
  const idxCard = (t, x, extra) => `<div><h3>${t}</h3><p class="big">${num(x.index, 2)}</p>
    <p class="${cls(x.change)}">${sg(x.change, 2)}（${sg(pct(x.change, x.index), 2)}%）</p>${extra}</div>`;
  const rv = v => v == null ? "-" : `<span class="${v >= 1 ? "up" : "down"}">${num(v, 2)} 倍</span>`;
  const cards = `<div class="sr">
    ${idxCard("加權指數", m.twse, `<p class="mute">上市成交金額 ${num(m.twse.value, 0)} 億・量比 5日 ${rv(m.ratio5)}／20日 ${rv(m.ratio20)}</p>`)}
    ${idxCard("櫃買指數", m.tpex, `<p class="mute">上櫃成交金額 ${num(m.tpex.value, 0)} 億</p>`)}
    ${breadthCard("上市漲跌家數", m.twse)}
    ${breadthCard("上櫃漲跌家數", m.tpex)}
  </div>`;
  const maxNet = Math.max(1, ...m.trend.map(r => Math.abs(r.net)));
  const tr = m.trend.slice().reverse().map(r => `<tr><td>${r.date}</td><td>${num(r.index, 2)}</td><td class="${cls(r.change)}">${sg(r.change, 2)}</td>
    <td>${num(r.value, 0)}</td><td>${num(r.tpex_value, 0)}</td><td class="up">${num(r.up)}</td><td class="down">${num(r.down)}</td>
    <td class="nb"><span class="${cls(r.net)}">${sg(r.net)}</span><i class="${r.net >= 0 ? "u" : "d"}" style="width:${Math.abs(r.net) / maxNet * 60}px"></i></td>
    <td class="${cls(r.adl)}">${sg(r.adl)}</td></tr>`).join("");
  const maxShare = Math.max(1, ...m.sectors.map(s => s.share));
  const sec = m.sectors.map(s => `<tr><td>${s.name}</td><td class="${cls(s.pct)}">${s.pct == null ? "-" : sg(s.pct, 2) + "%"}</td><td>${num(s.value, 2)}</td>
    <td class="sb"><i style="width:${s.share / maxShare * 100}px"></i>${num(s.share, 2)}%</td></tr>`).join("");
  return `<h2 class="sec">市場整體強弱（${m.date}）</h2><div class="sc opt">${cards}</div>` +
    ftable("近 10 個交易日：指數、量能與騰落", ["日期", "加權指數", "漲跌", "上市成交(億)", "上櫃成交(億)", "上漲家數", "下跌家數", "騰落（漲－跌）", "累計騰落"], [tr],
      '<p class="fn">漲跌家數為上市＋上櫃股票（不含 ETF、權證）；騰落＝上漲家數－下跌家數，累計騰落從表內第一天起算，指數漲但累計騰落往下時，代表只有少數權值股在撐盤。量比＝當日上市成交金額 ÷ 前 5 日／20 日平均。</p>') +
    ftable("上市類股：漲跌與資金占比", ["類股", "類股指數漲跌", "成交金額(億)", "占上市成交"], [sec],
      '<p class="fn">成交金額由上市普通股依產業別加總，占比以這些類股合計為分母；漲跌為證交所各類股指數。</p>');
}

// ---- 綜合分析：規則式訊號表 ----
function renderSignals(s) {
  if (!s) return '<div class="empty">綜合分析尚未產生，之後排程會自動補上。</div>';
  const tag = b => b > 0 ? '<span class="tag up">偏多</span>' : b < 0 ? '<span class="tag down">偏空</span>' : '<span class="tag nt">中性</span>';
  const { bull, bear, neutral, verdict } = s.score;
  const tot = bull + bear + neutral || 1;
  const vc = verdict === "偏多" ? "up" : verdict === "偏空" ? "down" : "";
  let last = "";
  const rows = s.items.map(i => {
    const g = i.group === last ? "" : i.group;
    last = i.group;
    return `<tr class="${g ? "g1" : ""}"><td class="grpc">${g}</td><td class="name">${i.name}</td><td class="val">${i.value}</td><td>${tag(i.bias)}</td><td class="dt">${i.detail}</td></tr>`;
  }).join("");
  const dates = [`股票 ${s.date}`, s.fut_date && `期貨 ${s.fut_date}`, `融資融券 ${s.chips_date || "尚未公布"}`].filter(Boolean).join("・");
  return `<h2 class="sec">綜合分析（${s.date}）</h2><div class="sc opt">
    <div class="sr">
      <div><h3>綜合判讀</h3><p class="big ${vc}">${verdict}</p><p class="mute">偏多 ${bull} 項・偏空 ${bear} 項・中性 ${neutral} 項</p>
        <div class="ratio"><i class="u" style="width:${bull / tot * 100}%"></i><i class="f" style="width:${neutral / tot * 100}%"></i><i class="d" style="width:${bear / tot * 100}%"></i></div></div>
      <div><h3>資料日期</h3><p>${dates}</p><p class="mute">產出時間 ${s.generated_at.replace("T", " ").slice(0, 16)}</p></div>
    </div></div>
    <div class="sc"><table class="ft sig"><thead><tr><th>分類</th><th>項目</th><th>數值</th><th>判讀</th><th>說明</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="fn">每項依固定門檻判讀：外資現貨 ±30 億、投信 ±10 億、騰落 ±200 家、外資台指與十大特定法人變化 ±1,000 口、小台散戶多空比較前 5 日平均 ±10 個百分點（反向：散戶偏多判偏空）、外資選擇權淨金額 ±0.5 億、P/C 比較前 5 日平均 ±5 個百分點、台積電外資 ±1,000 張、前 20 大權值股外資合計 ±5,000 張；量能放量（20 日量比 ≥1.2）時依漲跌判讀；融資在指數下跌時增加視為偏空、在指數上漲時減少視為偏多。偏多與偏空項數相差 3 項以上才判為偏多或偏空，否則為多空互見。此為規則統計，不是預測，也不構成投資建議。</p></div>`;
}

// ---- 籌碼篩選：連買連賣、籌碼背離、隔日沖（讀 data/screens.json，第一次打開分頁才載入） ----
let scr = null, scrState = { mode: "streak", cat: "fi", dir: 1, min: 3, etf: false, sort: null, flipView: null };
const SCR_MODES = [["streak", "連買連賣"], ["diverge", "籌碼背離"], ["flips", "隔日沖"]];
const pctCell = v => v == null ? "<td>-</td>" : `<td class="${cls(v)}">${sg(v, 2)}%</td>`;
const lotCell = v => `<td class="${cls(v)}">${sg(v)}</td>`;

function scrRows() {
  const s = scrState, list = (scr[s.mode === "streak" ? "streaks" : s.mode][s.cat] || []).filter(r => r.etf === s.etf);
  if (s.mode === "streak") return list.filter(r => Math.sign(r.days) === s.dir && Math.abs(r.days) >= s.min);
  if (s.mode === "diverge") return list.filter(r => Math.sign(r.cum) === s.dir);
  return list;
}

// 隔日沖：逐日名單（近 5 個交易日可切換）或熱門股（近 5 日沖銷次數、連續一買一賣天數）
function flipRows() {
  const s = scrState, d = s.flipView || scr.flip_dates[0];
  if (d === "hot") return (scr.flip_hot[s.cat] || []).filter(r => r.etf === s.etf)
    .map(r => ({ ...r, ...Object.fromEntries(r.lots.map((v, i) => ["l" + i, v])) }));
  return ((scr.flips[s.cat] || {})[d] || []).filter(r => r.etf === s.etf && Math.sign(r.prev) === s.dir);
}

function renderScreens() {
  if (!scr) return '<div class="empty">載入中…</div>';
  if (scr.error) return `<div class="empty">${scr.error}</div>`;
  const s = scrState, R = scr.rules;
  const cats = Object.entries(scr.cats).filter(([k]) => s.mode !== "diverge" || ["fi", "it"].includes(k));
  if (!cats.some(([k]) => k === s.cat)) s.cat = "fi";
  const btn = (attr, val, label, on) => `<button ${attr}="${val}" class="${on ? "on" : ""}">${label}</button>`;
  const hot = s.mode === "flips" && s.flipView === "hot";
  const fv = s.flipView || scr.flip_dates[0];
  const dirs = hot ? [] : s.mode === "streak" ? [[1, "連買"], [-1, "連賣"]] : s.mode === "diverge" ? [[1, "買超但不漲"], [-1, "賣超但不跌"]] : [[1, "前日買→今日賣"], [-1, "前日賣→今日買"]];
  const md = d => d.slice(5).replace("-", "/");
  const ctrl = `<nav class="optnav">${SCR_MODES.map(([k, t]) => btn("data-sm", k, t, s.mode === k)).join("")}</nav>
    <nav class="optnav">${cats.map(([k, t]) => btn("data-sc", k, t, s.cat === k)).join("")}</nav>
    ${s.mode === "flips" ? `<nav class="optnav">${scr.flip_dates.map(d => btn("data-sfv", d, md(d), fv === d)).join("")}${btn("data-sfv", "hot", `熱門股（近 ${R.flip_days} 日）`, hot)}</nav>` : ""}
    <nav class="optnav">${dirs.map(([v, t]) => btn("data-sd", v, t, s.dir === v)).join("")}
      ${s.mode === "streak" ? [3, 5].map(n => btn("data-sn", n, `${n} 日以上`, s.min === n)).join("") : ""}
      ${btn("data-se", 0, "個股", !s.etf)}${btn("data-se", 1, "ETF", s.etf)}</nav>`;
  const head = ["#", "代號", "名稱", "市場", "收盤價", "漲跌幅", "成交量(張)"];
  const keys = ["rank", "code", "name", "market", "close", "pct", "volume"];
  let extra;
  if (s.mode === "streak") extra = [["days", "連續天數"], ["cum", "期間累計(張)"], ["today", "當日(張)"], ["ppct", "期間漲跌幅"]];
  else if (s.mode === "diverge") extra = [["cum", `近${R.diverge_days}日累計(張)`], ["today", "當日(張)"], ["ppct", `近${R.diverge_days}日漲跌幅`]];
  else if (hot) extra = [...scr.flip_dates.slice().reverse().map((d, i) => ["l" + i, md(d)]), ["n_flip", "沖銷次數"], ["alt", "連續一買一賣"]];
  else extra = [["prev", "前日(張)"], ["today", "當日(張)"], ["ratio", "反向比例"]];
  let rows = (s.mode === "flips" ? flipRows() : scrRows()).map((r, i) => ({ ...r, rank: i + 1 }));
  if (s.sort) {
    const { k, dir } = s.sort;
    rows.sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k]) : (a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir);
  }
  const th = [...head.map((t, i) => [keys[i], t]), ...extra].map(([k, t]) =>
    `<th data-ssk="${k}" class="${s.sort?.k === k ? (s.sort.dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("");
  const body = rows.map(r => `<tr><td>${r.rank}</td><td>${stockLink(r.code, r.code)}</td><td class="name">${stockLink(r.code, r.name)}</td><td>${r.market}</td>
    <td>${r.close.toFixed(2)}</td>${pctCell(r.pct)}<td>${num(r.volume)}</td>` +
    extra.map(([k]) => k === "days" ? `<td>${Math.abs(r.days)} 天</td>` : k === "ppct" ? pctCell(r.ppct) : k === "ratio" ? `<td>${num(r.ratio, 1)}%</td>`
      : k === "n_flip" ? `<td>${r.n_flip} 次</td>` : k === "alt" ? `<td class="${r.alt >= R.flip_days ? "hot5" : ""}">${r.alt ? r.alt + " 天" : "-"}</td>` : lotCell(r[k])).join("") + "</tr>").join("");
  const rule = s.mode === "streak" ? `${scr.cats[s.cat]}每日買賣超至少 1 張且方向相同，連續 ${s.min} 天以上；期間累計與期間漲跌幅以連續的那幾天計算`
    : s.mode === "diverge" ? `${scr.cats[s.cat]}近 ${R.diverge_days} 日累計${s.dir > 0 ? "買超" : "賣超"} ${num(R.diverge_lots)} 張以上，但同期股價${s.dir > 0 ? "沒漲（≤0%）" : "沒跌（≥0%）"}`
    : hot ? `${scr.cats[s.cat]}近 ${R.flip_days} 日沖銷 ${R.hot_min_flips} 次以上，或連續一買一賣（每天 ${num(R.flip_lots)} 張以上、方向逐日相反）${R.hot_min_alt} 天以上；沖銷＝前一日買（賣）超 ${num(R.flip_lots)} 張以上、當日反向達 ${R.flip_ratio * 100}% 以上，第一天以再前一個交易日判斷`
    : `${md(fv)} ${scr.cats[s.cat]}前一日${s.dir > 0 ? "買超" : "賣超"} ${num(R.flip_lots)} 張以上，當日反向${s.dir > 0 ? "賣超" : "買超"}達前一日的 ${R.flip_ratio * 100}% 以上`;
  return `<h2 class="sec">籌碼篩選（${scr.date}）</h2><div class="sc opt">${ctrl}
    <p class="mute">條件：${rule}；只列當日成交量 ${num(R.min_vol)} 張以上。共 ${rows.length} 檔。</p></div>
    <div class="sc"><table class="ft scr"><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${head.length + extra.length}" class="mute">今天沒有符合條件的${s.etf ? " ETF" : "個股"}</td></tr>`}</tbody></table>
    <p class="fn">法人資料為證交所、櫃買中心三大法人買賣超日報（外資含外資自營商）；只能看到法人類別，看不到券商分點，所以「隔日沖」是指這一類法人整體一天買、隔天賣，不是特定分點主力。自營商（避險）多為權證避險，常一天買一天賣，訊號雜訊較大。期間漲跌幅以收盤價計算，未還原除權息。此為規則篩選，不構成投資建議。</p></div>`;
}

function bindScreens(box) {
  const set = (sel, fn) => box.querySelectorAll(sel).forEach(b => b.onclick = () => { fn(b); scrState.sort = null; render(); });
  set("[data-sm]", b => { scrState.mode = b.dataset.sm; });
  set("[data-sc]", b => { scrState.cat = b.dataset.sc; });
  set("[data-sd]", b => { scrState.dir = +b.dataset.sd; });
  set("[data-sn]", b => { scrState.min = +b.dataset.sn; });
  set("[data-se]", b => { scrState.etf = b.dataset.se === "1"; });
  set("[data-sfv]", b => { scrState.flipView = b.dataset.sfv; });
  box.querySelectorAll("[data-ssk]").forEach(el => el.onclick = () => {
    const k = el.dataset.ssk, cur = scrState.sort;
    scrState.sort = cur?.k === k ? { k, dir: -cur.dir } : { k, dir: ["rank", "code", "name", "market"].includes(k) ? 1 : -1 };
    render();
  });
}

let scrLoading = false;
function loadScreens() {
  if (scr || scrLoading) return;
  scrLoading = true;
  fetch("data/screens.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(j => { scr = j; })
    .catch(() => { scr = { error: "籌碼篩選資料尚未產生，之後排程會自動補上。" }; })
    .finally(() => { if (tab === "scr") render(); });
}

// 散戶多空比（坊間算法）：散戶＝全市場未平倉扣掉三大法人
function renderRetail(r) {
  if (!r) return "";
  const rows = r.rows.map(x => `<tr><td class="name">${x.label}</td><td>${num(x.oi)}</td><td>${num(x.long)}</td><td>${num(x.short)}</td>
    <td>${vd(x.net, x.net_d)}</td><td>${x.ratio == null ? "-" : vd(x.ratio, x.ratio_d, 2).replace(/(\d)<\/span>/, "$1%</span>")}</td><td class="${cls(x.trade_net)}">${sg(x.trade_net)}</td></tr>`);
  const tr = r.trend.slice().reverse().map(t => `<tr><td>${t.date}</td>${["TX", "MTX", "TMF"].map(c => `<td class="${cls(t[c])}">${t[c] == null ? "-" : sg(t[c], 2) + "%"}</td>`).join("")}</tr>`);
  return ftable(`散戶多空比（${r.date}，口）`, ["契約", "全市場未平倉", "散戶多單", "散戶空單", "散戶淨部位", "散戶多空比", "散戶當日交易淨口數"], rows,
      '<p class="fn">坊間算法：散戶多單＝全市場未平倉－三大法人多單；散戶空單＝全市場未平倉－三大法人空單；散戶多空比＝（散戶多單－散戶空單）÷全市場未平倉×100%。全市場未平倉含所有月份與週契約；散戶當日交易淨口數＝三大法人空方交易口數－多方交易口數；括號為較前一交易日的變化（多空比為百分點）。「散戶」是三大法人以外的所有交易人，包含大戶與一般投資人。</p>') +
    (tr.length > 1 ? ftable("散戶多空比走勢", ["日期", "台指（TXF）", "小台（MXF）", "微台（TMF）"], tr) : "");
}

// ---- 營收 × 估值 × 股價落後（讀 data/value.json，第一次打開分頁才載入） ----
let val = null, valLoading = false;
const valState = { on: { c_rev: true, c_val: true, c_lag: true, c_inst: true, yoy3: false, high12: false }, market: "", sort: null, open: new Set() };
const VAL_CONDS = [["c_rev", "營收轉強"], ["c_val", "估值偏低"], ["c_lag", "股價落後"], ["c_inst", "法人沒在買"], ["yoy3", "連續 3 個月年增"], ["high12", "營收創 12 個月新高"]];

function loadValue() {
  if (val || valLoading) return;
  valLoading = true;
  fetch("data/value.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(j => { val = j; })
    .catch(() => { val = { error: "營收估值資料尚未產生，之後排程會自動補上。" }; })
    .finally(() => { if (tab === "val") render(); });
}

function renderValue() {
  if (!val) return '<div class="empty">載入中…</div>';
  if (val.error) return `<div class="empty">${val.error}</div>`;
  const s = valState, R = val.rules, months = val.rev_months;
  const avail = k => k === "yoy3" ? months >= 3 : k === "high12" ? months >= 12 : true;
  const ym = `${val.rev_month.slice(0, 4)}/${val.rev_month.slice(4)}`;
  const desc = {
    c_rev: `當月營收年增 > ${R.rev_yoy}% 且累計年增 > ${R.rev_cum_yoy}%`,
    c_val: `本益比 < ${R.per_max} 倍，或低於同產業中位數`,
    c_lag: "近 60 日漲幅落後加權指數，或收盤低於 60 日均價",
    c_inst: `近 ${R.inst_days} 日外資＋投信合計沒有買超`,
    yoy3: `連續 3 個月營收年增 > ${R.rev_yoy}%`, high12: "當月營收為近 12 個月最高",
  };
  const conds = VAL_CONDS.map(([k, t]) => `<button data-vc="${k}" class="${s.on[k] && avail(k) ? "on" : ""}" ${avail(k) ? "" : "disabled"} title="${desc[k]}${avail(k) ? "" : `（營收資料累積 ${months} 個月，還不夠）`}">${t}</button>`).join("");
  const mk = [["", "全部"], ["上市", "上市"], ["上櫃", "上櫃"]].map(([v, t]) => `<button data-vm="${v}" class="${s.market === v ? "on" : ""}">${t}</button>`).join("");
  let rows = val.rows.filter(r => VAL_CONDS.every(([k]) => !s.on[k] || !avail(k) || r[k]) && (!s.market || r.market === s.market));
  if (s.sort) {
    const { k, dir } = s.sort;
    rows = rows.slice().sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k]) : (a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir);
  }
  const cols = [["rank", "#"], ["code", "代號"], ["name", "名稱"], ["industry", "產業"], ["close", "收盤價"], ["rev", "營收(億)"],
    ["yoy", "年增"], ["cum_yoy", "累計年增"], ["per", "本益比"], ["ind_per", "同業PER"], ["dy", "殖利率"],
    ["ret60", "近60日"], ["rel60", "相對大盤"], ["inst10", `法人${R.inst_days}日(張)`], ["score", "分數"]];
  const th = cols.map(([k, t]) => `<th data-vsk="${k}" class="${s.sort?.k === k ? (s.sort.dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("");
  const p2 = v => v == null ? "<td>-</td>" : `<td class="${cls(v)}">${sg(v, 2)}%</td>`;
  const n2 = v => `<td>${v == null ? "-" : num(v, 2)}</td>`;
  // 點 ▸ 或「註」展開該列細節（手機沒有滑鼠移上去的提示，所以細節都放在展開列）
  const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const detail = r => `<tr class="vd"><td colspan="${cols.length}"><div>
    <span>市場 <b>${r.market}</b></span><span>月增 <b class="${cls(r.mom)}">${r.mom == null ? "-" : sg(r.mom, 2) + "%"}</b></span>
    <span>淨值比 <b>${r.pb == null ? "-" : num(r.pb, 2)}</b></span><span>成交量 <b>${num(r.volume)}</b> 張（20 日均量 ${num(r.avg20)}）</span>
    <span>收盤${r.below_ma60 == null ? "：60 日均價資料不足" : r.below_ma60 ? "<b>低於</b> 60 日均價" : "高於 60 日均價"}</span></div>
    <p>${r.note ? `營收備註：${esc(r.note)}` : "這個月沒有營收備註。"}</p></td></tr>`;
  const body = rows.map((r, i) => {
    const open = s.open.has(r.code);
    return `<tr class="${open ? "vo" : ""}"><td><button class="vt" data-vt="${r.code}" aria-expanded="${open}" aria-label="展開 ${r.name} 細節">${open ? "▾" : "▸"}</button>${i + 1}</td><td>${stockLink(r.code, r.code)}</td><td class="name">${stockLink(r.code, r.name)}${r.note ? `<button class="nt" data-vt="${r.code}">註</button>` : ""}</td>
    <td>${r.industry}</td><td>${r.close.toFixed(2)}</td><td>${num(r.rev, 2)}</td>${p2(r.yoy)}${p2(r.cum_yoy)}
    ${n2(r.per)}${n2(r.ind_per)}<td>${r.dy == null ? "-" : num(r.dy, 2) + "%"}</td>${p2(r.ret60)}${p2(r.rel60)}<td class="${cls(r.inst10)}">${sg(r.inst10)}</td>
    <td><b>${r.score == null ? "-" : num(r.score, 1)}</b></td></tr>` + (open ? detail(r) : "");
  }).join("");
  return `<h2 class="sec">營收 × 估值 × 股價落後（${val.date}）</h2><div class="sc opt">
    <p class="mute">營收月份 ${ym}（已累積 ${months} 個月）・估值與股價 ${val.date}・加權指數近 60 日 ${sg(val.index_ret60, 2)}%（自 ${val.index_from}）</p>
    <nav class="optnav">${conds}</nav><nav class="optnav">${mk}</nav>
    <p class="mute">已選條件：${VAL_CONDS.filter(([k]) => s.on[k] && avail(k)).map(([k]) => desc[k]).join("；") || "無（列出全部）"}。共 ${rows.length} 檔。</p></div>
    <div class="sc"><table class="ft scr val"><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="mute">沒有同時符合這些條件的個股，可以取消部分條件</td></tr>`}</tbody></table>
    <p class="fn">只列上市櫃普通股；排除近 20 日均量不到 ${num(R.min_avg_vol)} 張、去年同月營收不到 ${R.min_rev_ly} 億的公司。本益比以近四季獲利計算，虧損公司沒有本益比，不會通過「估值偏低」；同業本益比為同產業（營收表的產業別）有本益比公司的中位數。分數 0～100：年增率越高、本益比越低、近 60 日相對大盤越落後，分數越高，三項各占三分之一。點每列最前面的 ▸ 或名稱旁的「註」可展開細節：營收備註（常是報價、併購、一次性收入等原因，請自行判斷）、市場、月增、淨值比、成交量。尚未排除全額交割股與處置股。營收要到 3 個月、12 個月後才能使用「連續 3 個月年增」「營收創 12 個月新高」。此為規則篩選，不構成投資建議。</p></div>`;
}

function bindValue(box) {
  box.querySelectorAll("[data-vc]").forEach(b => b.onclick = () => { valState.on[b.dataset.vc] = !valState.on[b.dataset.vc]; render(); });
  box.querySelectorAll("[data-vm]").forEach(b => b.onclick = () => { valState.market = b.dataset.vm; render(); });
  box.querySelectorAll("[data-vt]").forEach(b => b.onclick = () => {
    const c = b.dataset.vt;
    valState.open.has(c) ? valState.open.delete(c) : valState.open.add(c);
    render();
  });
  box.querySelectorAll("[data-vsk]").forEach(el => el.onclick = () => {
    const k = el.dataset.vsk, cur = valState.sort;
    valState.sort = cur?.k === k ? { k, dir: -cur.dir } : { k, dir: ["rank", "code", "name", "industry", "per", "ind_per", "ret60", "rel60", "inst10"].includes(k) ? 1 : -1 };
    render();
  });
}

// ---- 當沖觀察（讀 data/daytrade.json，第一次打開分頁才載入） ----
let dtd = null, dtLoading = false;
const dtState = { mode: "dt", etf: "stock", market: "", hide: false, sort: null, open: new Set() };
const DT_MODES = [["dt", "當沖量", "dt"], ["dt_ratio", "當沖比率", "dt_ratio"], ["amp", "振幅", "amp"], ["vol_ratio", "量能放大", "vol_ratio"], ["flag", "有標記", "volume"]];
const DT_BAD = ["處置", "非當沖標的"];

function loadDaytrade() {
  if (dtd || dtLoading) return;
  dtLoading = true;
  fetch("data/daytrade.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(j => { dtd = j; })
    .catch(() => { dtd = { error: "當沖觀察資料尚未產生，之後排程會自動補上。" }; })
    .finally(() => { if (tab === "dt") render(); });
}

function renderDaytrade() {
  if (!dtd) return '<div class="empty">載入中…</div>';
  if (dtd.error) return `<div class="empty">${dtd.error}</div>`;
  const s = dtState, R = dtd.rules, md = d => d.slice(5).replace("-", "/");
  const btn = (attr, v, t, on) => `<button ${attr}="${v}" class="${on ? "on" : ""}">${t}</button>`;
  const mode = DT_MODES.find(m => m[0] === s.mode);
  let rows = dtd.rows.filter(r => (s.etf === "all" || (s.etf === "etf") === r.etf) && (!s.market || r.market === s.market)
    && (!s.hide || !r.flags.some(f => DT_BAD.includes(f))) && (s.mode !== "flag" || r.flags.length) && (r.volume >= R.min_vol || s.mode === "flag"));
  const key = s.sort?.k || mode[2], dir = s.sort ? s.sort.dir : -1;
  rows = rows.slice().sort((a, b) => (typeof a[key] === "string" ? a[key].localeCompare(b[key]) : (a[key] ?? -Infinity) - (b[key] ?? -Infinity)) * dir).slice(0, 100);
  const mk = m => { const x = dtd.market[m]; return `<div><h3>${m}當沖</h3><p class="big">${num(x.ratio_vol, 2)}%</p><p class="mute">占成交股數；買進金額占 ${num(x.ratio_buy, 2)}%</p></div>`; };
  const cols = [["rank", "#"], ["code", "代號"], ["name", "名稱"], ["close", "收盤價"], ["pct", "漲跌幅"], ["amp", "振幅"], ["volume", "成交量(張)"],
    ["vol_ratio", "量比(20日)"], ["dt", "當沖(張)"], ["dt_ratio", "當沖比率"], ["flags", "標記"]];
  const th = cols.map(([k, t]) => `<th data-dsk="${k}" class="${(s.sort?.k || mode[2]) === k ? (dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("");
  const badge = f => `<span class="fg ${DT_BAD.includes(f) ? "bad" : f === "暫停先賣後買" ? "warn" : ""}">${f}</span>`;
  const body = rows.map((r, i) => {
    const open = s.open.has(r.code);
    return `<tr class="${open ? "vo" : ""}"><td>${r.flag_text.length ? `<button class="vt" data-dt="${r.code}" aria-expanded="${open}">${open ? "▾" : "▸"}</button>` : '<span class="vt"></span>'}${i + 1}</td>
      <td>${stockLink(r.code, r.code)}</td><td class="name">${stockLink(r.code, r.name)}<span class="mute2"> ${r.market}</span></td><td>${r.close.toFixed(2)}</td>${pctCell(r.pct)}
      <td>${r.amp == null ? "-" : num(r.amp, 2) + "%"}</td><td>${num(r.volume)}</td><td>${r.vol_ratio == null ? "-" : num(r.vol_ratio, 2) + " 倍"}</td>
      <td>${r.dt == null ? "-" : num(r.dt)}</td><td>${r.dt_ratio == null ? "-" : num(r.dt_ratio, 1) + "%"}</td><td class="fgs">${r.flags.map(badge).join("")}</td></tr>` +
      (open ? `<tr class="vd"><td colspan="${cols.length}"><p>${r.flag_text.map(t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>")}</p></td></tr>` : "");
  }).join("");
  return `<h2 class="sec">當沖觀察（${dtd.date}，供 ${md(dtd.next_day)} 盤前參考）</h2><div class="sc opt">
    <div class="sr">${mk("上市")}${mk("上櫃")}</div>
    <nav class="optnav">${DT_MODES.map(([k, t]) => btn("data-dm", k, t, s.mode === k)).join("")}</nav>
    <nav class="optnav">${[["stock", "個股"], ["etf", "ETF"], ["all", "全部"]].map(([v, t]) => btn("data-de", v, t, s.etf === v)).join("")}
      ${[["", "上市＋上櫃"], ["上市", "上市"], ["上櫃", "上櫃"]].map(([v, t]) => btn("data-dk", v, t, s.market === v)).join("")}
      ${btn("data-dh", 1, "隱藏不能當沖的", s.hide)}</nav>
    <p class="mute">依「${mode[1]}」排序，取前 100 檔；只列成交量 ${num(R.min_vol)} 張以上（「有標記」另含成交量較小但有標記的股票）。點 ▸ 看標記說明。</p></div>
    <div class="sc"><table class="ft scr dtt"><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="mute">沒有符合的股票</td></tr>`}</tbody></table>
    <p class="fn">當沖(張)與當沖比率來自證交所、櫃買中心「當日沖銷交易標的及成交量值」；當沖比率＝當沖成交股數÷當日成交股數。振幅＝（最高－最低）÷昨收。量比＝當日成交量÷前 20 日平均。標記：<b>處置</b>（下一交易日仍在處置期間，人工撮合、通常要預收款券，不能現股當沖）、<b>非當沖標的</b>（不在當日現股當沖標的清單）、<b>暫停先賣後買</b>（當日註記或下一交易日在預告期間）、<b>注意</b>（當日被公布注意交易資訊）、<b>可能處置</b>（注意次數累計可能達處置標準）。盤中即時報價請以券商軟體為準；此為盤後整理，不構成投資建議。</p></div>`;
}

function bindDaytrade(box) {
  const set = (sel, fn) => box.querySelectorAll(sel).forEach(b => b.onclick = () => { fn(b); render(); });
  set("[data-dm]", b => { dtState.mode = b.dataset.dm; dtState.sort = null; });
  set("[data-de]", b => { dtState.etf = b.dataset.de; });
  set("[data-dk]", b => { dtState.market = b.dataset.dk; });
  set("[data-dh]", () => { dtState.hide = !dtState.hide; });
  set("[data-dt]", b => { const c = b.dataset.dt; dtState.open.has(c) ? dtState.open.delete(c) : dtState.open.add(c); });
  box.querySelectorAll("[data-dsk]").forEach(el => el.onclick = () => {
    const k = el.dataset.dsk, cur = dtState.sort || { k: DT_MODES.find(m => m[0] === dtState.mode)[2], dir: -1 };
    if (k === "flags") return;
    dtState.sort = cur.k === k ? { k, dir: -cur.dir } : { k, dir: ["rank", "code", "name"].includes(k) ? 1 : -1 };
    render();
  });
}

function renderFut(f) {
  const ix = f.index;
  const mk = [`<tr class="idx"><td class="name">加權指數</td><td>${num(ix.close, 2)}</td><td class="${cls(ix.change)}">${sg(ix.change, 2)}</td><td class="${cls(ix.change)}">${sg(ix.pct, 2)}%</td><td>${num(ix.value_tril, 6)} 兆元</td><td>-</td><td>-</td></tr>`]
    .concat(f.market.map(r => `<tr><td class="name">${r.name}</td><td>${num(r.close, r.close % 1 ? 1 : 0)}</td><td class="${cls(r.change)}">${sg(r.change, r.close % 1 ? 1 : 0)}</td><td class="${cls(r.change)}">${r.pct == null ? "-" : sg(r.pct, 2) + "%"}</td><td>${num(r.volume)}</td><td>${num(r.oi)}</td><td class="${cls(r.oi_chg)}">${sg(r.oi_chg)}</td></tr>`));
  const inst = f.inst.map(r => `<tr class="${r.name === "合計" ? "tot" : ""}"><td class="name">${r.name}</td><td class="${cls(r.cash)}">${sg(r.cash, 2)}</td>` +
    [["fut", 0], ["call", 0], ["put", 0], ["call_amt", 2], ["put_amt", 2]].map(([k, d]) => `<td>${vd(r[k], r[k + "_d"], d)}</td>`).join("") + "</tr>");
  const large = f.large.map(r => `<tr><td class="name">${r.name}</td>` +
    ["sp_near", "sp_far", "ot_near", "ot_far"].map(k => `<td>${vd(r[k], r[k + "_d"])}</td>`).join("") +
    `<td class="oi">${num(r.oi)}<span class="dv ${cls(r.oi_d)}">(${sg(r.oi_d)})</span></td></tr>`);
  return ftable(`收盤行情表（${f.date}）`, ["合約", "收盤", "漲跌", "漲跌幅", "成交量", "OI", "OI增減"], mk,
      '<p class="fn">收盤採期交所日最後結算價；成交量為一般＋盤後；OI增減為相較前一交易日。</p>') +
    ftable("三大法人籌碼變化（口／億元）", ["", "現貨(金額)", "台指(口數)", "Call(口數)", "Put(口數)", "Call(金額)", "Put(金額)"], inst,
      `<p class="fn">現貨為買賣超金額（億元）；其餘為淨未平倉，括號為較前一交易日${f.prev_date ? `（${f.prev_date}）` : ""}的變化；台指為臺股期貨（不含小台、微台）。</p>`) +
    renderRetail(f.retail) +
    ftable("十大交易人期權淨部位（口）", ["", "十大(特定人) 近月", "十大(特定人) 其他月", "十大(非特定人) 近月", "十大(非特定人) 其他月", "全市場OI"], large,
      '<p class="fn">淨部位＝十大買方部位－十大賣方部位；特定人＝特定法人，非特定人＝其餘交易人；近月為最近月份契約，其他月含週契約；括號為較前一交易日的變化。</p>');
}

function render() {
  const box = document.querySelector(".scroll");
  const cs = cols();
  document.getElementById("view").hidden = isFi(tab) || ["fut", "opt", "mkt", "sig", "scr", "val", "dt"].includes(tab);
  if (tab === "mkt") { box.innerHTML = renderMarket(data.market_breadth); return; }
  if (tab === "sig") { box.innerHTML = renderSignals(data.signals); return; }
  if (tab === "scr") { loadScreens(); box.innerHTML = renderScreens(); bindScreens(box); return; }
  if (tab === "val") { loadValue(); box.innerHTML = renderValue(); bindValue(box); return; }
  if (tab === "dt") { loadDaytrade(); box.innerHTML = renderDaytrade(); bindDaytrade(box); return; }
  if (tab === "opt") {
    box.innerHTML = data.fut ? renderOpt(data.fut.opt, data.fut.pc, data.fut.date) : '<div class="empty">期交所資料尚未公布，之後排程會自動補上。</div>';
    box.querySelectorAll("[data-opt]").forEach(b => b.onclick = () => { optSel = +b.dataset.opt; render(); });
    return;
  }
  if (tab === "fut") {
    box.innerHTML = data.fut ? renderFut(data.fut) : '<div class="empty">期交所資料尚未公布，之後排程會自動補上。</div>';
    return;
  }
  if (isFi(tab)) {
    box.innerHTML = FI_SECTIONS[tab].map(([key, title, tot]) =>
      `<h2 class="sec">${title}</h2><div class="sc">` +
      tableHtml(key, data[key], cs, [["前20大合計", sumOf(data[key])], [tab === "fi" ? "全市場個股合計" : "全市場ETF合計", data[tot]]]) + "</div>").join("");
  } else {
    box.innerHTML = tableHtml(tab, data[tab], cs);
  }
  box.querySelectorAll("th[data-k]").forEach(el => el.onclick = () => {
    const k = el.dataset.k, sec = el.dataset.sec;
    sort = sort?.sec === sec && sort.k === k ? { sec, k, dir: -sort.dir } : { sec, k, dir: ["rank", "code", "name", "market"].includes(k) ? 1 : -1 };
    render();
  });
}

const siteSel = document.getElementById("site");
siteSel.innerHTML = Object.entries(SITES).map(([k, [t]]) => `<option value="${k}"${k === site ? " selected" : ""}>${t}</option>`).join("");
siteSel.onchange = () => {
  site = siteSel.value;
  try { localStorage.setItem("site", site); } catch (e) { /* 略過 */ }
  if (data) render();
};

document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x === b));
  tab = b.dataset.t; sort = null;
  if (data) render();
});

document.querySelectorAll("#view button").forEach(b => b.onclick = () => {
  document.querySelectorAll("#view button").forEach(x => x.classList.toggle("on", x === b));
  view = b.dataset.v; sort = null;
  if (data) render();
});

fetch("data/latest.json", { cache: "no-cache" })
  .then(r => { if (!r.ok) throw 0; return r.json(); })
  .then(j => {
    data = j;
    const hm = t => t.replace("T", " ").slice(0, 16);
    // 股票與期貨各自更新，日期分開標示；股票還沒更新時顯示的是前一交易日
    let meta = `股票資料日期 ${j.date}（${j.market}）・更新 ${hm(j.updated_at)}`;
    if (j.fut) meta += `　期貨資料日期 ${j.fut.date}${j.fut.updated_at ? `・更新 ${hm(j.fut.updated_at)}` : ""}`;
    const behind = j.fut && j.fut.date > j.date;
    document.getElementById("meta").innerHTML = meta +
      (behind ? `<br><span class="behind">股票盤後資料尚未公布，目前顯示前一交易日（${j.date}）；期貨已更新至 ${j.fut.date}</span>` : "");
    render();
  })
  .catch(() => {
    document.getElementById("meta").textContent = "";
    document.querySelector(".scroll").innerHTML =
      '<div class="empty">尚無資料。請先執行 scripts/fetch_data.py，或等待排程第一次更新。</div>';
  });
