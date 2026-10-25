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

let data = null, tab = "home", view = "fi", sort = null;

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
  const groupRow = "<tr>" + `<th class="plain" colspan="${plain}"><span class="swipe">← 左滑看${grps[0][1]} →</span></th>` +
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
let optSel = 0, optOpen = null;   // optOpen：點開看口數的履約價（手機沒有滑鼠移上去）
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
    const open = optOpen === r[0];
    return mark + `<div class="br${hot.has(r[0]) ? " hot" : ""}${open ? " on" : ""}" title="${tip(r)}" data-k="${r[0]}" role="button" tabindex="0" aria-expanded="${open}">` +
      `<div class="pl">${lab.has("p" + r[0]) ? `<em>${num(r[2])}</em>` : ""}<i class="put" style="width:${r[2] / max * 100}%"></i></div>` +
      `<div class="k">${num(r[0])}</div>` +
      `<div class="cl"><i class="call" style="width:${r[1] / max * 100}%"></i>${lab.has("c" + r[0]) ? `<em>${num(r[1])}</em>` : ""}</div></div>` +
      (open ? `<div class="bt"><span class="put">賣權 <b>${num(r[2])}</b> 口${r[4] == null ? "" : ` <span class="${cls(r[4])}">(${sg(r[4])})</span>`}</span>` +
        `<b class="k">${num(r[0])}</b><span class="call">買權 <b>${num(r[1])}</b> 口${r[3] == null ? "" : ` <span class="${cls(r[3])}">(${sg(r[3])})</span>`}</span></div>` : "");
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
    <div class="lg"><span><i class="put"></i>賣權未平倉（支撐）</span><span><i class="call"></i>買權未平倉（壓力）</span><span class="mute">加權指數上下 ${Math.round(o.chart_range * 100)}%；點任一列（電腦也可滑鼠移上去）看口數與變化</span></div>
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
    <details class="cond"><summary>共 <b>${rows.length}</b> 檔・條件說明</summary>
    <p class="mute">已選條件：${VAL_CONDS.filter(([k]) => s.on[k] && avail(k)).map(([k]) => desc[k]).join("；") || "無（列出全部）"}。點 ▸ 或「註」看細節。</p></details></div>
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

// ---- 長期體質（讀 data/longterm.json，第一次打開分頁才載入） ----
let ltd = null, ltLoading = false;
const ltState = { on: { c_roe: true, c_eps: true, c_div: true, c_expect: true, c_cheap: false }, noai: true, market: "", sort: null, open: new Set() };
const LT_CONDS = [["c_roe", "ROE 穩定"], ["c_eps", "獲利成長"], ["c_div", "連續配息"], ["c_expect", "預估報酬 ≥ 門檻"], ["c_cheap", "本益比低於 5 年中位數"]];

function loadLongterm() {
  if (ltd || ltLoading) return;
  ltLoading = true;
  fetch("data/longterm.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(j => { ltd = j; })
    .catch(() => { ltd = { error: "長期體質資料尚未產生，之後排程會自動補上。" }; })
    .finally(() => { if (tab === "lt") render(); });
}

function renderLongterm() {
  if (!ltd) return '<div class="empty">載入中…</div>';
  if (ltd.error) return `<div class="empty">${ltd.error}</div>`;
  const s = ltState, R = ltd.rules;
  const desc = {
    c_roe: `近 ${R.years} 年每個年度點的 ROE 都 ≥ ${R.roe_min}%`, c_eps: `近 ${R.years} 年都沒有虧損，且 EPS 年化成長 > 0`,
    c_div: `近 ${R.years} 年每年都有配現金股利`, c_expect: `殖利率＋EPS 年化成長 ≥ ${R.expect_min}%`, c_cheap: "目前本益比低於自己近 5 年的中位數",
  };
  const btn = (attr, v, t, on, title = "") => `<button ${attr}="${v}" class="${on ? "on" : ""}" title="${title}">${t}</button>`;
  let rows = ltd.rows.filter(r => LT_CONDS.every(([k]) => !s.on[k] || r[k]) && (!s.noai || !r.ai) && (!s.market || r.market === s.market));
  if (s.sort) {
    const { k, dir } = s.sort;
    rows = rows.slice().sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k]) : (a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir);
  }
  const cols = [["rank", "#"], ["code", "代號"], ["name", "名稱"], ["industry", "產業"], ["close", "收盤價"], ["dy", "殖利率"], ["eps_cagr", "EPS 年化成長"],
    ["expect", "預估報酬"], ["roe_min", "5 年最低 ROE"], ["roe_now", "目前 ROE"], ["per", "本益比"], ["per_med5", "5 年本益比中位數"]];
  const th = cols.map(([k, t]) => `<th data-lsk="${k}" class="${s.sort?.k === k ? (s.sort.dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("");
  const p2 = v => v == null ? "<td>-</td>" : `<td class="${cls(v)}">${sg(v, 2)}%</td>`;
  const pl = v => v == null ? "<td>-</td>" : `<td>${num(v, 2)}%</td>`;
  const ym = x => `${x.slice(0, 4)}/${x.slice(4)}`;
  const detail = r => `<tr class="vd"><td colspan="${cols.length}"><div class="ltd"><table><thead><tr><th>時點</th>${r.years.map((y, i) => `<th>${i ? ym(y.ym) : "目前"}</th>`).join("")}</tr></thead><tbody>
    <tr><td>近四季 EPS</td>${r.years.map(y => `<td>${y.eps == null ? "虧損/無" : num(y.eps, 2)}</td>`).join("")}</tr>
    <tr><td>現金股利</td>${r.years.map(y => `<td>${y.dps == null ? "-" : num(y.dps, 2)}</td>`).join("")}</tr>
    <tr><td>ROE</td>${r.years.map(y => `<td>${y.roe == null ? "-" : num(y.roe, 1) + "%"}</td>`).join("")}</tr></tbody></table>
    <p class="mute">市場 ${r.market}・股價淨值比 ${r.pb == null ? "-" : num(r.pb, 2)}。由每月本益比、殖利率、淨值比反推的近似值，不是財報原始數字。</p></div></td></tr>`;
  const body = rows.slice(0, 200).map((r, i) => {
    const open = s.open.has(r.code);
    return `<tr class="${open ? "vo" : ""}"><td><button class="vt" data-lt="${r.code}" aria-expanded="${open}">${open ? "▾" : "▸"}</button>${i + 1}</td><td>${stockLink(r.code, r.code)}</td>
      <td class="name">${stockLink(r.code, r.name)}</td><td>${r.industry}</td><td>${r.close.toFixed(2)}</td>${pl(r.dy)}${p2(r.eps_cagr)}<td><b>${r.expect == null ? "-" : sg(r.expect, 2) + "%"}</b></td>
      ${pl(r.roe_min)}${pl(r.roe_now)}<td>${r.per == null ? "-" : num(r.per, 2)}</td><td>${r.per_med5 == null ? "-" : num(r.per_med5, 2)}</td></tr>` + (open ? detail(r) : "");
  }).join("");
  const partial = ltd.months < ltd.need_months ? `<p class="behind">估值歷史已回補 ${ltd.months}／${ltd.need_months} 個月，缺月份的個股暫時不會出現，之後排程會繼續補。</p>` : "";
  return `<h2 class="sec">長期體質篩選（${ltd.date}）</h2><div class="sc opt">${partial}
    <nav class="optnav">${LT_CONDS.map(([k, t]) => btn("data-lc", k, t, s.on[k], desc[k])).join("")}</nav>
    <nav class="optnav">${btn("data-lai", 1, "排除 AI／電子產業", s.noai, ltd.ai_industries.join("、") + "（電信業者" + (ltd.telecom || []).join("、") + "除外）")}
      ${[["", "上市＋上櫃"], ["上市", "上市"], ["上櫃", "上櫃"]].map(([v, t]) => btn("data-lk", v, t, s.market === v)).join("")}</nav>
    <details class="cond"><summary>共 <b>${rows.length}</b> 檔${rows.length > 200 ? "（顯示前 200 檔）" : ""}・條件說明</summary>
    <p class="mute">已選條件：${[...LT_CONDS.filter(([k]) => s.on[k]).map(([k]) => desc[k]), s.noai ? "排除 " + ltd.ai_industries.join("、") + "（電信業者" + (ltd.telecom || []).join("、") + "除外）" : ""].filter(Boolean).join("；") || "無"}。預設依預估報酬排序；點 ▸ 看 5 年逐年數字。</p></details></div>
    <div class="sc"><table class="ft scr lt"><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="mute">沒有同時符合這些條件的個股，可以取消部分條件</td></tr>`}</tbody></table>
    <p class="fn">資料由證交所、櫃買中心每月的本益比、殖利率、股價淨值比反推（每月取 15 日起第一個交易日）：近四季 EPS＝收盤價÷本益比、現金股利＝收盤價×殖利率（上櫃直接用每股股利）、每股淨值＝收盤價÷淨值比、ROE≈近四季 EPS÷每股淨值。年度點為「目前」與 1～5 年前同月份。EPS 年化成長＝目前與 5 年前近四季 EPS 的年化成長率；預估報酬＝目前殖利率＋EPS 年化成長，是粗估，不代表未來報酬。虧損時本益比為「-」，該年只能標示虧損。產業別取自營收表。只列上市櫃普通股、近 20 日均量 ${R.min_avg_vol} 張以上、上市滿 5 年的公司。此為規則篩選，不構成投資建議。</p></div>`;
}

function bindLongterm(box) {
  const set = (sel, fn) => box.querySelectorAll(sel).forEach(b => b.onclick = () => { fn(b); render(); });
  set("[data-lc]", b => { ltState.on[b.dataset.lc] = !ltState.on[b.dataset.lc]; });
  set("[data-lai]", () => { ltState.noai = !ltState.noai; });
  set("[data-lk]", b => { ltState.market = b.dataset.lk; });
  set("[data-lt]", b => { const c = b.dataset.lt; ltState.open.has(c) ? ltState.open.delete(c) : ltState.open.add(c); });
  box.querySelectorAll("[data-lsk]").forEach(el => el.onclick = () => {
    const k = el.dataset.lsk, cur = ltState.sort;
    ltState.sort = cur?.k === k ? { k, dir: -cur.dir } : { k, dir: ["rank", "code", "name", "industry", "per", "per_med5"].includes(k) ? 1 : -1 };
    render();
  });
}

// ---- 共用：分頁第一次打開才載入 JSON；可排序表格 ----
const store = {}, loading = {};
function need(file, tabs) {
  if (store[file] || loading[file]) return store[file] || null;
  loading[file] = true;
  fetch(`data/${file}.json`, { cache: "no-cache" })
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(j => { store[file] = j; })
    .catch(() => { store[file] = { error: true }; })
    .finally(() => { loading[file] = false; if (tabs.includes(tab)) render(); });
  return null;
}
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const md = d => d.slice(5).replace("-", "/");
const WD = "日一二三四五六";
const mdw = d => `${md(d)}（${WD[new Date(d + "T00:00:00Z").getUTCDay()]}）`;
const twToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const btn = (attr, v, t, on, dis = false) => `<button ${attr}="${v}" class="${on ? "on" : ""}"${dis ? " disabled" : ""}>${t}</button>`;
// 依網頁上的「權值股／熱門個股／熱門 ETF／外資買賣超」判斷是否為熱門股
const hotCodes = () => new Set(["cap", "stocks", "etfs", "fi_buy", "fi_sell"].flatMap(k => (data?.[k] || []).map(r => r.code)));

const tsort = {};   // 各表格目前的排序 {k, dir}
// cols：[鍵, 標題, 產生 <td> 的函式]；def：預設排序
function stable(id, rows, cols, def, limit = 100) {
  const st = tsort[id] || def;
  rows = rows.slice().sort((a, b) => (typeof a[st.k] === "string" ? a[st.k].localeCompare(b[st.k]) : (a[st.k] ?? -Infinity) - (b[st.k] ?? -Infinity)) * st.dir || a.code.localeCompare(b.code));
  const th = cols.map(([k, t]) => `<th data-ts="${id}" data-tk="${k}" class="${st.k === k ? (st.dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("");
  const body = rows.slice(0, limit).map((r, i) => `<tr class="${r._cls || ""}">${cols.map(c => c[2](r, i)).join("")}</tr>`).join("");
  return { html: `<table class="ft scr nt2"><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="mute">沒有符合的資料</td></tr>`}</tbody></table>`, n: rows.length };
}
function bindTs(box) {
  box.querySelectorAll("[data-ts]").forEach(el => el.onclick = () => {
    const id = el.dataset.ts, k = el.dataset.tk, cur = tsort[id];
    if (k === "rank") return;
    tsort[id] = cur?.k === k ? { k, dir: -cur.dir } : { k, dir: ["code", "name", "market", "d", "cat"].includes(k) ? 1 : -1 };
    render();
  });
}
const td = v => `<td>${v}</td>`;
const tdRank = (r, i) => td(i + 1);
const tdCode = r => td(stockLink(r.code, r.code));
const tdName = r => `<td class="name">${stockLink(r.code, esc(r.name))}<span class="mute2"> ${r.market}</span></td>`;
const tdNum = (k, d = 0) => r => td(r[k] == null ? "-" : num(r[k], d));
const tdSg = (k, d = 0, unit = "") => r => r[k] == null ? td("-") : `<td class="${cls(r[k])}">${sg(r[k], d)}${unit}</td>`;
const tdPct = k => tdSg(k, 2, "%");
const kindBtns = (attr, cur) => [["stock", "個股"], ["etf", "ETF"], ["all", "全部"]].map(([v, t]) => btn(attr, v, t, cur === v)).join("");
const kindOk = (r, k) => k === "all" || (k === "etf") === r.etf;

// ---- 盤前速覽（data/pre.json，07:40 更新） ----
function renderPre() {
  const p = need("pre", ["pre"]), ev = need("events", ["pre", "news", "exr"]);
  if (!p) return '<div class="empty">載入中…</div>';
  if (p.error) return '<div class="empty">盤前資料尚未產生：每個交易日早上 07:40 自動更新（夜盤約 05:00 收盤）。</div>';
  const today = twToday(), e = p.events;
  const stale = p.date !== today ? `<p class="behind">這是 ${p.date} 的盤前資料（今天 ${today} 休市或尚未更新）。</p>` : "";
  const night = p.night.map(r => `<tr><td class="name">${r.name}<span class="mute2"> ${r.month.slice(2, 4)}/${r.month.slice(4)}</span></td><td>${num(r.close, r.close % 1 ? 2 : 0)}</td>` +
    `<td class="${cls(r.change)}">${sg(r.change, r.close % 1 ? 2 : 0)}</td><td class="${cls(r.pct)}">${r.pct == null ? "-" : sg(r.pct, 2) + "%"}</td>` +
    `<td>${num(r.high, r.close % 1 ? 2 : 0)}</td><td>${num(r.low, r.close % 1 ? 2 : 0)}</td><td>${num(r.volume)}</td></tr>`);
  const fxd = p.fx[0].dates;
  const fx = p.fx.map(r => `<tr><td class="name">${r.name}</td>${r.values.map(v => td(v == null ? "-" : num(v, v < 10 ? 4 : 3))).join("")}` +
    `<td class="${cls(r.change)}">${r.change == null ? "-" : sg(r.change, r.values.at(-1) < 10 ? 4 : 3)}</td></tr>`);
  const names = (xs, n = 12) => xs.length ? xs.slice(0, n).map(x => stockLink(x.code, esc(x.name))).join("、") + (xs.length > n ? ` …等 ${xs.length} 檔` : "") : "無";
  const exToday = e.exright.filter(x => x.d === p.date), exSoon = e.exright.filter(x => x.d > p.date);
  const cards = [
    `<div><h3>選擇權結算</h3><p class="bd">${e.settle.length ? e.settle.join("、") + " 今日結算" : "今日無結算"}</p></div>`,
    `<div><h3>今日除權息（${exToday.length} 檔）</h3><p>${names(exToday)}</p><p class="mute">未來 7 天還有 ${exSoon.length} 檔・<button class="lk" data-go="exr">看除權息 ›</button></p></div>`,
    `<div><h3>處置中（${(e.flags["處置"] || []).length} 檔）</h3><p>${names(e.flags["處置"] || [])}</p><p class="mute">人工撮合，通常要預收款券，不能現股當沖</p></div>`,
    `<div><h3>暫停先賣後買（${(e.flags["暫停先賣後買"] || []).length} 檔）</h3><p>${names(e.flags["暫停先賣後買"] || [])}</p><p class="mute">${e.flags_from ? `依 ${e.flags_from} 盤後公告` : "前一日當沖觀察資料不是供今天使用，暫不列出"}・<button class="lk" data-go="dt">看當沖觀察 ›</button></p></div>`,
  ];
  let news = "";
  if (ev && !ev.error) {
    const since = e.stock_date, hot = hotCodes();
    const xs = ev.news.filter(x => x.d > since || (x.d === since && x.t >= "13:30:00"));
    const li = xs.slice(0, 30).map(x => `<li><span class="mute2">${md(x.d)} ${x.t.slice(0, 5)}</span> ${stockLink(x.code, `<b>${esc(x.name)}</b>`)} ${hot.has(x.code) ? '<span class="fg bad">熱門</span>' : ""}<span class="fg">${x.cat}</span> ${esc(x.subject)}</li>`).join("");
    news = `<h2 class="sec">${md(since)} 收盤後的重大訊息（${xs.length} 則）</h2><div class="sc opt"><ul class="nl">${li || '<li class="mute">沒有</li>'}</ul>
      <p class="mute">${xs.length > 30 ? "只列最新 30 則・" : ""}<button class="lk" data-go="news">看全部重大訊息 ›</button></p></div>`;
  }
  return `<h2 class="sec">盤前速覽（${p.date}・更新 ${p.updated_at.replace("T", " ").slice(0, 16)}）</h2><div class="sc opt">${stale}<div class="sr">${cards.join("")}</div></div>` +
    ftable("期貨夜盤（近月）", ["合約", "收盤", "漲跌", "漲跌幅", "最高", "最低", "成交量"], night,
      `<p class="fn">夜盤為前一晚 15:00～今天 05:00；期交所把它記在今天的交易日。漲跌相對前一個交易日的結算價（不是日盤收盤價）。</p>`) +
    ftable("匯率（期交所每日外幣參考匯率）", ["", ...fxd.map(md), "較前日"], fx,
      `<p class="fn">每日外幣參考匯率為前一個交易日的資料；美元／新台幣數字變大＝新台幣貶值。</p>`) + news;
}

// ---- 重大訊息（data/events.json） ----
const newsState = { d: "", cat: "", hot: false };
function renderNews() {
  const ev = need("events", ["pre", "news", "exr"]);
  if (!ev) return '<div class="empty">載入中…</div>';
  if (ev.error) return '<div class="empty">重大訊息資料尚未產生，之後排程會自動補上。</div>';
  const s = newsState, hot = hotCodes();
  const base = ev.news.filter(x => (!s.d || x.d === s.d) && (!s.hot || hot.has(x.code)));
  const xs = base.filter(x => !s.cat || x.cat === s.cat);
  const cnt = c => base.filter(x => x.cat === c).length;
  const items = xs.slice(0, 200).map(x => `<details class="nw"><summary><span class="mute2">${md(x.d)} ${x.t.slice(0, 5)}</span> ${stockLink(x.code, `<b>${esc(x.code)} ${esc(x.name)}</b>`)}<span class="mute2"> ${x.market}</span>
    ${hot.has(x.code) ? '<span class="fg bad">熱門</span>' : ""}<span class="fg">${x.cat}</span><span class="sj">${esc(x.subject)}</span></summary>
    <div class="nwd"><p>${esc(x.desc).replace(/\n/g, "<br>")}</p><p class="mute">${x.rule ? `符合條款：${esc(x.rule)}・` : ""}原文：<a href="https://mops.twse.com.tw/mops/#/web/t05sr01_1" target="_blank" rel="noopener noreferrer">公開資訊觀測站</a></p></div></details>`).join("");
  return `<h2 class="sec">重大訊息（近 ${ev.news_days} 天，共 ${ev.news.length} 則）</h2><div class="sc opt">
    <nav class="optnav">${btn("data-nd", "", "全部日期", !s.d)}${ev.news_dates.map(d => btn("data-nd", d, mdw(d), s.d === d)).join("")}</nav>
    <nav class="optnav">${btn("data-nc", "", `全部（${base.length}）`, !s.cat)}${ev.categories.map(c => btn("data-nc", c, `${c}（${cnt(c)}）`, s.cat === c, !cnt(c))).join("")}
      ${btn("data-nh", 1, "只看熱門股", s.hot)}</nav>
    <div class="nws">${items || '<p class="mute">沒有符合的訊息</p>'}</div>
    <p class="fn">${xs.length > 200 ? "只列最新 200 則；" : ""}點一則看說明。資料來源：證交所、櫃買中心 OpenAPI 的「上市／上櫃公司每日重大訊息」（公司自行申報的公告原文，不是新聞報導）。分類依主旨關鍵字自動判斷，可能不精準。「熱門」＝出現在本站權值股、熱門個股／ETF、外資買賣超前 20 名。OpenAPI 只提供最近一天，本站從 2026-10-24 起每天累積。</p></div>`;
}

// ---- 除權息（data/events.json） ----
const exrState = { kind: "all" };
function renderExr() {
  const ev = need("events", ["pre", "news", "exr"]);
  if (!ev) return '<div class="empty">載入中…</div>';
  if (ev.error) return '<div class="empty">除權息資料尚未產生，之後排程會自動補上。</div>';
  const today = twToday();
  const rows = ev.exright.filter(r => kindOk(r, exrState.kind)).map(r => ({ ...r, _cls: r.d === today ? "td0" : r.d < today ? "past" : "" }));
  const t = stable("exr", rows, [
    ["d", "除權息日", r => td(mdw(r.d))], ["code", "代號", tdCode], ["name", "名稱", tdName], ["kind", "類型", r => td(r.kind)],
    ["cash", "現金股利(元)", r => td(r.cash == null ? '<span class="mute2">待公告</span>' : num(r.cash, r.cash < 1 ? 3 : 2))],
    ["stock", "配股(每股)", r => td(r.stock == null ? "-" : num(r.stock, 4))], ["close", "收盤價", tdNum("close", 2)],
    ["yield", "現金殖利率", r => td(r.yield == null ? "-" : num(r.yield, 2) + "%")],
  ], { k: "d", dir: 1 }, 300);
  return `<h2 class="sec">除權除息預告（${t.n} 檔）</h2><div class="sc opt"><nav class="optnav">${kindBtns("data-xk", exrState.kind)}</nav></div>
    <div class="sc">${t.html}<p class="fn">資料來源：證交所「除權除息預告表」、櫃買中心「上櫃股票除權除息預告表」。收盤價與殖利率用 ${ev.close_date || "-"} 收盤價計算（除息當天參考價會扣掉股利）；現金殖利率＝現金股利÷收盤價，只算這一次配發。灰色為已除權息（保留 3 天），底色為今天。</p></div>`;
}

// ---- 借券賣出（data/sbl.json） ----
const SBL_MODES = [["sell", "當日借券賣出", "sell", -1], ["d1", "餘額增加（當日）", "d1", -1], ["d5", "餘額增加（5 日）", "d5", -1], ["d5r", "餘額減少（5 日）", "d5", 1], ["ratio", "占成交量", "sell_ratio", -1]];
const sblState = { mode: "sell", kind: "stock" };
function renderSbl() {
  const sb = need("sbl", ["sbl"]);
  if (!sb) return '<div class="empty">載入中…</div>';
  if (sb.error) return '<div class="empty">借券賣出資料尚未產生，之後排程會自動補上。</div>';
  const s = sblState, m = SBL_MODES.find(x => x[0] === s.mode);
  const rows = sb.rows.filter(r => kindOk(r, s.kind) && (s.mode !== "ratio" || r.volume >= 1000));
  const t = stable("sbl", rows, [
    ["rank", "#", tdRank], ["code", "代號", tdCode], ["name", "名稱", tdName], ["close", "收盤價", tdNum("close", 2)], ["pct", "漲跌幅", tdPct("pct")],
    ["volume", "成交量", tdNum("volume")], ["sell", "借券賣出", tdNum("sell")], ["ret", "還券", tdNum("ret")], ["bal", "借券賣出餘額", tdNum("bal")],
    ["d1", "當日增減", tdSg("d1")], ["d5", "5 日增減", tdSg("d5")], ["sell_ratio", "占成交量", r => td(r.sell_ratio == null ? "-" : num(r.sell_ratio, 1) + "%")],
    ["short", "融券餘額", tdNum("short")], ["fi", "外資當日", tdSg("fi")],
  ], tsort.sbl ? null : { k: m[2], dir: m[3] });
  return `<h2 class="sec">借券賣出（${sb.date}）</h2><div class="sc opt">
    <nav class="optnav">${SBL_MODES.map(([k, tt]) => btn("data-bm", k, tt, s.mode === k)).join("")}</nav>
    <nav class="optnav">${kindBtns("data-bk", s.kind)}</nav>
    <p class="mute">依「${m[1]}」排序，取前 100 檔${s.mode === "ratio" ? "（只列成交量 1,000 張以上）" : ""}；單位：張。</p></div>
    <div class="sc">${t.html}<p class="fn">資料來源：證交所、櫃買中心「融券借券賣出餘額」。借券賣出是借股票來賣（多為法人避險或放空），餘額增加代表放空部位變多；還券代表回補。5 日增減＝今天餘額－${sb.dates.length >= 6 ? sb.dates[5] : "5 個交易日前"} 餘額。占成交量＝當日借券賣出÷當日成交量。外資當日為三大法人買賣超（張）。借券賣出餘額約晚上 9 點後公布。</p></div>`;
}

// ---- 大戶持股（data/holders.json，集保每週） ----
const BIG_MODES = [["up", "千張大戶增加", "d1000", -1, true], ["down", "千張大戶減少", "d1000", 1, true], ["conc", "股東人數減少", "dpeople", 1, true], ["high", "千張大戶比例", "r1000", -1, false]];
const bigState = { mode: null, kind: "stock" };
function renderBig() {
  const h = need("holders", ["big"]);
  if (!h) return '<div class="empty">載入中…</div>';
  if (h.error) return '<div class="empty">大戶持股資料尚未產生，之後排程會自動補上。</div>';
  const s = bigState, one = !h.prev;
  if (!s.mode) s.mode = one ? "high" : "up";
  const m = BIG_MODES.find(x => x[0] === s.mode);
  const rows = h.rows.filter(r => kindOk(r, s.kind) && r.volume >= 100 && (!m[4] || r[m[2]] != null));
  const pp = k => r => r[k] == null ? td("-") : `<td class="${cls(r[k])}">${sg(r[k], 2)}</td>`;
  const t = stable("big", rows, [
    ["rank", "#", tdRank], ["code", "代號", tdCode], ["name", "名稱", tdName], ["close", "收盤價", tdNum("close", 2)], ["wk_pct", "週漲跌幅", tdPct("wk_pct")],
    ["r1000", "千張大戶%", r => td(num(r.r1000, 2))], ["d1000", "週增減", pp("d1000")], ["d1000_4w", "4 週增減", pp("d1000_4w")],
    ["r400", "400 張以上%", r => td(num(r.r400, 2))], ["d400", "週增減", pp("d400")], ["people", "股東人數", tdNum("people")], ["dpeople", "人數週增減", tdPct("dpeople")],
  ], tsort.big ? null : { k: m[2], dir: m[3] });
  const first = one ? `<p class="behind">目前只有 ${h.date} 這一週。集保每週公布一次且只提供最新一週，週增減要等下一週資料出來後才算得出來（4 週增減要累積 5 週）。</p>` : "";
  return `<h2 class="sec">大戶持股（集保 ${h.date}${h.prev ? `，比較 ${h.prev}` : ""}）</h2><div class="sc opt">${first}
    <nav class="optnav">${BIG_MODES.map(([k, tt, , , needPrev]) => btn("data-gm", k, tt, s.mode === k, needPrev && one)).join("")}</nav>
    <nav class="optnav">${kindBtns("data-gk", s.kind)}</nav>
    <p class="mute">依「${m[1]}」排序，取前 100 檔；只列成交量 100 張以上。增減單位為百分點。</p></div>
    <div class="sc">${t.html}<p class="fn">資料來源：集保結算所「集保戶股權分散表」（每週最後一個交易日的持股，通常週五晚間或週六公布）。千張大戶＝單一集保戶持有 1,000 張（1,000,001 股）以上；400 張以上＝400,001 股以上。週漲跌幅為兩次集保資料日之間的還原股價漲跌。大戶比例上升、股東人數減少，通常解讀為籌碼集中；集保戶包含法人、信託與券商保管帳戶，不等於自然人大戶。</p></div>`;
}
function bindNew(box) {
  const set = (sel, fn) => box.querySelectorAll(sel).forEach(b => b.onclick = () => { fn(b); render(); });
  set("[data-nd]", b => { newsState.d = b.dataset.nd; });
  set("[data-nc]", b => { newsState.cat = b.dataset.nc; });
  set("[data-nh]", () => { newsState.hot = !newsState.hot; });
  set("[data-xk]", b => { exrState.kind = b.dataset.xk; });
  set("[data-bm]", b => { sblState.mode = b.dataset.bm; delete tsort.sbl; });
  set("[data-bk]", b => { sblState.kind = b.dataset.bk; });
  set("[data-gm]", b => { bigState.mode = b.dataset.gm; delete tsort.big; });
  set("[data-gk]", b => { bigState.kind = b.dataset.gk; });
  box.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  bindTs(box);
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

const NEW_TABS = { pre: renderPre, news: renderNews, exr: renderExr, sbl: renderSbl, big: renderBig };

function render() {
  const box = document.querySelector(".scroll");
  const cs = cols();
  document.getElementById("note").hidden = !(["cap", "stocks", "etfs"].includes(tab) || isFi(tab));
  if (tab === "home") {
    document.getElementById("view").hidden = true;
    box.innerHTML = renderHome();
    box.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
    return;
  }
  document.getElementById("view").hidden = isFi(tab) || ["fut", "opt", "mkt", "sig", "scr", "val", "dt", "lt", ...Object.keys(NEW_TABS)].includes(tab);
  if (tab === "mkt") { box.innerHTML = renderMarket(data.market_breadth); return; }
  if (tab === "sig") { box.innerHTML = renderSignals(data.signals); return; }
  if (tab === "scr") { loadScreens(); box.innerHTML = renderScreens(); bindScreens(box); return; }
  if (tab === "val") { loadValue(); box.innerHTML = renderValue(); bindValue(box); return; }
  if (tab === "dt") { loadDaytrade(); box.innerHTML = renderDaytrade(); bindDaytrade(box); return; }
  if (tab === "lt") { loadLongterm(); box.innerHTML = renderLongterm(); bindLongterm(box); return; }
  if (tab in NEW_TABS) { box.innerHTML = NEW_TABS[tab](); bindNew(box); return; }
  if (tab === "opt") {
    box.innerHTML = data.fut ? renderOpt(data.fut.opt, data.fut.pc, data.fut.date) : '<div class="empty">期交所資料尚未公布，之後排程會自動補上。</div>';
    box.querySelectorAll("[data-opt]").forEach(b => b.onclick = () => { optSel = +b.dataset.opt; optOpen = null; render(); });
    box.querySelectorAll(".br[data-k]").forEach(el => {
      const tog = () => {
        const k = +el.dataset.k, y = el.getBoundingClientRect().top;
        optOpen = optOpen === k ? null : k;
        render();
        // 重畫後讓點的那一列留在原本的位置（上面的列收合時畫面不會跳）
        const now = document.querySelector(`.br[data-k="${k}"]`);
        if (now) window.scrollBy(0, now.getBoundingClientRect().top - y);
      };
      el.onclick = tog;
      el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tog(); } };
    });
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

// ---- 導覽：7 大類 × 子分頁；網址 #分頁 會記住目前位置（重新整理、分享、返回鍵都可用） ----
// 圖示用內嵌 SVG（文字符號在不同手機上長得不一樣）
const ICON = p => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const GROUPS = [
  ["home", "總覽", ICON('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'), [["home", "今日重點"], ["pre", "盤前速覽"], ["sig", "綜合訊號"]]],
  ["mkt", "大盤", ICON('<path d="M3 20h18"/><path d="M4 16l5-5 4 3 7-8"/>'), [["mkt", "市場強弱"]]],
  ["fo", "期權", ICON('<path d="M7 20V5"/><path d="M3 9l4-4 4 4"/><path d="M17 4v15"/><path d="M13 15l4 4 4-4"/>'), [["fut", "台指期"], ["opt", "選擇權支撐壓力"]]],
  ["chip", "籌碼", ICON('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>'), [["cap", "權值股"], ["stocks", "熱門個股"], ["etfs", "熱門 ETF"], ["fi", "外資買賣超"], ["fi_etf", "ETF 外資"], ["scr", "籌碼篩選"], ["sbl", "借券賣出"], ["big", "大戶持股"]]],
  ["pick", "選股", ICON('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'), [["val", "營收估值"], ["lt", "長期體質"]]],
  ["ev", "事件", ICON('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'), [["news", "重大訊息"], ["exr", "除權息"]]],
  ["dt", "當沖", ICON('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'), [["dt", "當沖觀察"]]],
];
const groupOf = t => GROUPS.find(g => g[3].some(([k]) => k === t)) || GROUPS[0];

function drawNav() {
  const g = groupOf(tab);
  document.getElementById("groups").innerHTML = GROUPS.map(([k, t, ic, subs]) =>
    `<button data-g="${k}" class="${g[0] === k ? "on" : ""}" aria-current="${g[0] === k ? "page" : "false"}">${ic}<span>${t}</span></button>`).join("");
  const tabs = document.getElementById("tabs");
  tabs.hidden = g[3].length < 2;
  tabs.innerHTML = g[3].map(([k, t]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${t}</button>`).join("");
  document.querySelectorAll("#groups button").forEach(b => b.onclick = () => go(GROUPS.find(x => x[0] === b.dataset.g)[3][0][0]));
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => go(b.dataset.t));
  tabs.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "center" });
}

function go(t, push = true) {
  if (!GROUPS.some(g => g[3].some(([k]) => k === t))) t = "home";
  tab = t; sort = null;
  if (push && location.hash.slice(1) !== t) history.pushState(null, "", "#" + t);
  drawNav();
  if (data) { render(); window.scrollTo({ top: 0 }); }
}
window.addEventListener("popstate", () => go(location.hash.slice(1) || "home", false));

document.querySelectorAll("#view button").forEach(b => b.onclick = () => {
  document.querySelectorAll("#view button").forEach(x => x.classList.toggle("on", x === b));
  view = b.dataset.v; sort = null;
  if (data) render();
});

// ---- 今日重點：每張卡片點下去到對應分頁 ----
function renderHome() {
  const d = data, mb = d.market_breadth, f = d.fut, s = d.signals;
  const card = (to, title, body, sub = "") => `<button class="hc" data-go="${to}"><h3>${title}</h3>${body}${sub ? `<p class="mute">${sub}</p>` : ""}<span class="more">看詳細 ›</span></button>`;
  const big = (v, cl = "") => `<p class="big ${cl}">${v}</p>`;
  const item = name => (s?.items || []).find(i => i.name.startsWith(name));
  const cards = [];
  if (s) {
    const { bull, bear, neutral, verdict } = s.score, tot = bull + bear + neutral || 1;
    cards.push(card("sig", "綜合判讀", big(verdict, verdict === "偏多" ? "up" : verdict === "偏空" ? "down" : "") +
      `<div class="ratio"><i class="u" style="width:${bull / tot * 100}%"></i><i class="f" style="width:${neutral / tot * 100}%"></i><i class="d" style="width:${bear / tot * 100}%"></i></div>`,
      `偏多 ${bull}・偏空 ${bear}・中性 ${neutral}（${s.items.length} 項規則）`));
  }
  if (mb) {
    const x = mb.twse, pct = x.change / (x.index - x.change) * 100;
    cards.push(card("mkt", "加權指數", big(num(x.index, 2)) + `<p class="${cls(x.change)}">${sg(x.change, 2)}（${sg(pct, 2)}%）</p>`,
      `成交 ${num(x.value, 0)} 億・20 日量比 ${mb.ratio20 == null ? "-" : num(mb.ratio20, 2) + " 倍"}`));
    const t = mb.trend[mb.trend.length - 1];
    cards.push(card("mkt", "漲跌家數（上市＋上櫃）", `<p class="bd"><span class="up">上漲 ${num(t.up)}</span><span class="down">下跌 ${num(t.down)}</span></p>` +
      `<div class="ratio"><i class="u" style="width:${t.up / (t.up + t.down) * 100}%"></i><i class="d" style="width:${t.down / (t.up + t.down) * 100}%"></i></div>`,
      `騰落 ${sg(t.net)}・近 10 日累計 ${sg(t.adl)}`));
  }
  const fi = item("外資現貨");
  if (fi) cards.push(card("fi", "外資現貨（上市）", big(fi.value, fi.value.startsWith("-") ? "down" : "up"), fi.detail));
  if (f) {
    const x = f.inst.find(r => r.name === "外資");
    cards.push(card("fut", "外資台指期淨未平倉", big(sg(x.fut) + " 口", cls(x.fut)), `較前日 ${sg(x.fut_d)} 口・資料 ${f.date}`));
    const r = f.retail?.rows.find(z => z.code === "MTX");
    if (r) cards.push(card("fut", "小台散戶多空比", big(sg(r.ratio, 2) + "%", cls(r.ratio)), `較前日 ${sg(r.ratio_d, 2)} 個百分點・散戶淨 ${sg(r.net)} 口`));
    const o = f.opt?.series?.[0];
    if (o) cards.push(card("opt", `最近結算 ${o.label}`,
      `<p class="bd"><span>壓力 <b>${o.resist[0] ? num(o.resist[0].strike) : "-"}</b></span><span>支撐 <b>${o.support[0] ? num(o.support[0].strike) : "-"}</b></span></p>`,
      `加權 ${num(f.opt.ref, 0)}・此系列 P/C ${o.pc == null ? "-" : num(o.pc, 1) + "%"}`));
  }
  const top3 = (rows, t) => rows.slice(0, 3).map(r => `<li><span>${r.name}</span><b class="${cls(r.fi_today)}">${sg(r.fi_today)}</b></li>`).join("") || `<li class="mute">${t}</li>`;
  cards.push(card("fi", "外資買賣超前 3 名（張）",
    `<p class="t3h">買超</p><ol class="t3">${top3(d.fi_buy, "無")}</ol><p class="t3h">賣超</p><ol class="t3">${top3(d.fi_sell, "無")}</ol>`));
  return `<h2 class="sec">今日重點（股票 ${d.date}${f ? `・期貨 ${f.date}` : ""}）</h2><div class="sc opt"><div class="home">${cards.join("")}</div>
    <p class="fn">點卡片看詳細資料。綜合判讀依固定規則統計各項訊號，不是預測，也不構成投資建議。</p></div>`;
}

tab = location.hash.slice(1) || "home";
drawNav();

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
    go(location.hash.slice(1) || "home", false);
  })
  .catch(() => {
    document.getElementById("meta").textContent = "";
    document.querySelector(".scroll").innerHTML =
      '<div class="empty">尚無資料。請先執行 scripts/fetch_data.py，或等待排程第一次更新。</div>';
  });
