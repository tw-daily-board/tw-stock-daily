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
const ftable = (title, head, rows, extra = "", tcls = "") =>
  `<h2 class="sec">${title}</h2><div class="sc"><table class="ft ${tcls}"><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>${extra}</div>`;

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
const vcls = v => v === "偏多" ? "up" : v === "偏空" ? "down" : "";
const leanTag = b => b > 0 ? '<span class="tag up">偏多</span>' : b < 0 ? '<span class="tag down">偏空</span>' : '<span class="tag neu">中性</span>';
function termBox(t) {
  const dims = t.dims.map(d => `<li><span>${d.name}</span>${leanTag(d.lean)}<span class="mute2">${d.bull} 多・${d.bear} 空・${d.n - d.bull - d.bear} 中性</span></li>`).join("");
  return `<div><h3>${t.name}判讀</h3><p class="big ${vcls(t.verdict)}">${t.verdict}</p>
    <p class="mute">偏多 ${t.bull} 個面向・偏空 ${t.bear} 個・中性 ${t.neutral} 個</p><ul class="dl">${dims}</ul></div>`;
}
function renderSignals(s) {
  if (!s) return '<div class="empty">綜合分析尚未產生，之後排程會自動補上。</div>';
  if (!s.terms) return '<div class="empty">綜合分析格式已更新，下次排程後顯示新版。</div>';
  const DN = { spot: "現貨籌碼", fut: "期權籌碼", breadth: "市場廣度", sentiment: "情緒槓桿", position: "指數位置" };
  const table = term => {
    let last = "";
    const its = s.items.filter(i => i.term === term).sort((a, b) => (a.dim ? Object.keys(DN).indexOf(a.dim) : 9) - (b.dim ? Object.keys(DN).indexOf(b.dim) : 9));
    const rows = its.map(i => {
      const gname = i.dim ? DN[i.dim] : "資訊（不計分）";
      const g = gname === last ? "" : gname;
      last = gname;
      return `<tr class="${g ? "g1" : ""}"><td class="grpc">${g}</td><td class="name">${i.name}</td><td class="val">${i.value}</td><td>${i.scored ? leanTag(i.bias) : '<span class="tag neu">資訊</span>'}</td><td class="dt">${i.detail}</td></tr>`;
    }).join("");
    return `<table class="ft sig"><thead><tr><th>面向</th><th>項目</th><th>數值</th><th>判讀</th><th>說明</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  const dates = [`股票 ${s.date}`, s.fut_date && `期貨 ${s.fut_date}`, `融資融券 ${s.chips_date || "尚未公布"}`, `趨勢 ${s.trend_date || "-"}`].filter(Boolean).join("・");
  return `<h2 class="sec">綜合分析（${s.date}）</h2><div class="sc opt">
    <div class="sr">${termBox(s.terms.short)}${termBox(s.terms.mid)}
      <div><h3>資料日期</h3><p>${dates}</p><p class="mute">產出時間 ${s.generated_at.replace("T", " ").slice(0, 16)}</p>
        <p class="mute">判讀方式：先把每個面向內的計分項目加總，得出該面向偏多、偏空或中性；偏多與偏空的面向數相差 2 個以上，才判為偏多或偏空，否則為多空互見。</p></div>
    </div></div>
    <h2 class="sec">短線（看今天的變化）</h2><div class="sc">${table("short")}</div>
    <h2 class="sec">中期（看近 20～60 個交易日）</h2><div class="sc">${table("mid")}
    <p class="fn">短線門檻：外資現貨 ±30 億、投信 ±10 億、台積電外資 ±1,000 張、前 20 大權值股外資合計 ±5,000 張、全市場借券賣出餘額單日 ±0.3%（增加偏空）、騰落 ±200 家、漲停減跌停 ±9 家、量能放量（20 日量比 ≥1.2）時依漲跌判讀、外資台指與十大特定法人變化 ±1,000 口、外資選擇權淨金額 ±0.5 億、融資在指數下跌時增加偏空／指數上漲時減少偏多、小台散戶多空比較前幾日平均 ±10 個百分點（反向）、P/C 比較前 5 日平均 ±5 個百分點。
    中期門檻：指數在 20／60 日均線之上偏多、之下偏空；外資 20 日累計 ±1,000 億；借券賣出餘額 5 日 ±1%（增加偏空）；騰落線與指數 20 日同向時依騰落方向、背離時反向判讀；外資台指淨未平倉、散戶多空比（反向）、P/C 比、融資餘額（反向）、台指 VIX（反向：恐慌視為偏多）在近 60 日區間的前後 10% 才判讀。
    此為規則統計，不是預測，也不構成投資建議。</p></div>`;
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
const store = {}, loading = {}, wantBy = {};
function need(file, tabs) {
  tabs.forEach(t => (wantBy[file] ||= new Set()).add(t));
  if (store[file] || loading[file]) return store[file] || null;
  loading[file] = true;
  fetch(`data/${file}.json`, { cache: "no-cache" })
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(j => { store[file] = j; })
    .catch(() => { store[file] = { error: true }; })
    .finally(() => { loading[file] = false; if (wantBy[file].has(tab)) render(); });
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

// ---- 盤前速覽（data/pre.json，07:15 更新） ----
function renderPre() {
  const p = need("pre", ["pre"]), ev = need("events", ["pre", "news", "exr"]);
  if (!p) return '<div class="empty">載入中…</div>';
  if (p.error) return '<div class="empty">盤前資料尚未產生：每個交易日早上 07:15 自動更新（夜盤約 05:00 收盤）。</div>';
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
  const nd = p.night_date || p.date;
  const sess = p.night_from ? `${mdw(p.night_from)} 15:00 開盤～隔天 05:00` : "前一個交易日晚上";
  const nightNote = `<p class="${nd !== p.date ? "behind" : "mute"}">${nd !== p.date ? "今天不是這筆夜盤的交易日（休市或手動執行）。" : ""}這是 ${sess} 的夜盤，期交所記在 ${mdw(nd)} 交易日。</p>`;
  return `<h2 class="sec">盤前速覽（${p.date}・更新 ${p.updated_at.replace("T", " ").slice(0, 16)}）</h2><div class="sc opt">${stale}<div class="sr ev2">${cards.join("")}</div></div>` +
    worldHtml(p.world) +
    ftable(`期貨夜盤（近月，${md(nd)} 交易日）`, ["合約", "收盤", "漲跌", "漲跌幅", "最高", "最低", "成交量"], night,
      nightNote + `<p class="fn">夜盤為前一個交易日 15:00～隔天 05:00；期交所把它記在下一個交易日（遇到休市會跳過，例如週五晚上的夜盤記在週一）。漲跌相對前一個交易日的結算價（不是日盤收盤價）。手機版不顯示最高、最低。</p>`, "ngt") +
    ftable("匯率（期交所每日外幣參考匯率）", ["", ...fxd.map(md), "較前日"], fx,
      `<p class="fn">每日外幣參考匯率為前一個交易日的資料；美元／新台幣數字變大＝新台幣貶值。手機版只顯示最近 3 天。</p>`, "fxt") + news;
}

// ---- 國際市場（盤前速覽；Yahoo Finance／Nasdaq.com 非官方介面） ----
function worldHtml(w) {
  if (!w) return "";
  const dd = x => x.dec ?? 2;
  const row = x => x.close == null
    ? `<tr><td class="name">${esc(x.name)}<span class="mute2"> ${esc(x.sym)}</span></td><td colspan="4" class="mute2">未取得</td></tr>`
    : `<tr><td class="name">${esc(x.name)}<span class="mute2"> ${esc(x.sym)}</span></td><td>${num(x.close, dd(x))}${x.live ? ' <span class="fg warn">盤中</span>' : ""}</td>` +
      `<td class="${cls(x.change)}">${sg(x.change, dd(x))}</td><td class="${cls(x.pct)}">${x.pct == null ? "-" : sg(x.pct, 2) + "%"}</td><td class="mute2">${x.date ? md(x.date) : esc(x.time || "")}</td></tr>`;
  const grp = (rows, key) => [...new Set(rows.map(r => r[key]))].map(g => `<tr class="gh"><td colspan="5">${g}</td></tr>` + rows.filter(r => r[key] === g).map(row).join("")).join("");
  const head = `<thead><tr><th>項目</th><th>收盤</th><th>漲跌</th><th>漲跌幅</th><th>日期</th></tr></thead>`;
  const a = w.adr;
  const adr = a && a.close != null ? `<div class="sr"><div><h3>台積電 ADR（TSM）</h3><p class="big">${num(a.close, 2)} <small class="${cls(a.change)}">${sg(a.change, 2)}（${sg(a.pct, 2)}%）</small>${a.live ? ' <span class="fg warn">盤中</span>' : ""}</p>
      <p class="mute">${a.date ? md(a.date) + " 收盤" : esc(a.time || "")}・資料 ${a.src}</p></div>
    ${a.premium != null ? `<div><h3>ADR 溢價</h3><p class="big ${cls(a.premium)}">${sg(a.premium, 2)}%</p><p class="mute">ADR 換算台股 ${num(a.equiv, 1)} 元（× ${num(a.fx, 3)} ÷ 5，${a.fx_src}）vs 台股收盤 ${num(a.tw_close, 1)} 元</p></div>` : ""}</div>` : "";
  return `<h2 class="sec">國際市場（更新 ${w.updated_at.replace("T", " ").slice(5, 16)}）</h2><div class="sc opt">${adr}</div>
    <div class="sc"><table class="ft wd">${head}<tbody>${grp(w.markets, "group")}</tbody></table></div>
    <h2 class="sec">相關美股</h2><div class="sc"><table class="ft wd">${head}<tbody>${grp(w.stocks, "group")}</tbody></table>
    <p class="fn">資料來源：Yahoo Finance（Nasdaq.com 備援，美股個股），皆為公開但非官方的網頁介面，可能延遲或暫時抓不到；抓不到的項目顯示「未取得」，不補任何數字。「盤中」表示抓取時該市場仍在交易，數字是最新成交價而不是收盤。期貨幾乎全天交易，是抓取時的最新價。日期為該市場當地的交易日。ADR 溢價＝台積電 ADR × 美元兌新台幣 ÷ 5（1 股 ADR＝5 股普通股）相對台股收盤的差距。OpenAI 尚未上市，沒有股價；微軟為其最大股東，甲骨文有大型算力合約。</p></div>`;
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
// ---- 趨勢（data/trend.json）：每張圖一個量、一條 Y 軸，日期對齊；點或滑過任一張，所有圖同一天一起標示 ----
const trState = { days: 60, sel: null };
const TR_CHARTS = [
  { k: "index", t: "加權指數", type: "line", f: v => num(v, 2) },
  { k: "fi", t: "外資現貨買賣超（上市，億元）", type: "bar", f: v => sg(v, 2) + " 億" },
  { k: "fi_oi", t: "外資台指期淨未平倉（口）", type: "line", f: v => sg(v) + " 口", zero: true },
  { k: ["MTX", "TMF"], t: "散戶多空比（%）", type: "line", names: ["小台", "微台"], colors: ["var(--call)", "var(--put)"], f: v => sg(v, 2) + "%", zero: true },
  { k: "adl", t: "騰落線（上市＋上櫃，漲家數－跌家數累計）", type: "line", f: v => sg(v), sub: r => r.up == null ? "" : `漲 ${num(r.up)}・跌 ${num(r.down)}` },
  { k: "fin_amt", t: "融資餘額（上市＋上櫃，億元）", type: "line", f: v => num(v, 2) + " 億" },
  { k: "pc_oi", t: "選擇權 P/C 比（未平倉，%）", type: "line", f: v => num(v, 2) + "%" },
];
// 台指 VIX 與 20 日歷史波動率：單位都是年化 %，可以共用一條 Y 軸
const VIX_CHART = { k: ["vix", "hv20"], t: "台指 VIX vs 20 日歷史波動率（年化 %）", type: "line", names: ["VIX", "歷史波動率"], colors: ["var(--call)", "var(--put)"], f: v => num(v, 2) + "%" };
TR_CHARTS.push(VIX_CHART);
function niceTicks(lo, hi) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / 3, p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  const a = Math.floor(lo / step) * step, out = [];
  for (let v = a; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  if (out.at(-1) < hi) out.push(out.at(-1) + step);
  return out;
}
const compact = v => Math.abs(v) >= 1e5 ? num(v / 1e4, 0) + "萬" : num(v, Math.abs(v) < 10 && v % 1 ? 1 : 0);
function trChart(c, rows, W, ci) {
  const keys = Array.isArray(c.k) ? c.k : [c.k], H = 150, L = 50, R = 10, T = 10, B = 22, pw = W - L - R, ph = H - T - B;
  const vals = rows.flatMap(r => keys.map(k => r[k])).filter(v => v != null);
  if (!vals.length) return `<div class="tc"><h3>${c.t}</h3><p class="mute">尚無資料</p></div>`;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (c.type === "bar" || c.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const ticks = niceTicks(lo, hi); lo = ticks[0]; hi = ticks.at(-1);
  const n = rows.length, bw = pw / n, x = i => L + bw * (i + 0.5), y = v => T + ph - (v - lo) / (hi - lo) * ph;
  let g = ticks.map(v => `<line class="gd${v === 0 && lo < 0 ? " z" : ""}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="yl" x="${L - 6}" y="${y(v) + 4}">${compact(v)}</text>`).join("");
  const xi = [0, Math.floor((n - 1) / 2), n - 1];
  g += xi.map((i, j) => `<text class="xl" x="${x(i)}" y="${H - 6}" text-anchor="${["start", "middle", "end"][j]}">${md(rows[i].date)}</text>`).join("");
  let marks = "";
  if (c.type === "bar") {
    const w = Math.max(1, Math.min(24, bw - 2)), y0 = y(0);
    marks = rows.map((r, i) => {
      const v = r[keys[0]];
      if (v == null || v === 0) return "";
      const top = Math.min(y(v), y0), h = Math.max(1, Math.abs(y(v) - y0)), rr = Math.min(4, w / 2, h);
      // 4px 圓角在資料端、基線端是直角
      const x0 = x(i) - w / 2, x1 = x0 + w;
      const d = v > 0 ? `M${x0},${y0}V${top + rr}Q${x0},${top} ${x0 + rr},${top}H${x1 - rr}Q${x1},${top} ${x1},${top + rr}V${y0}Z`
        : `M${x0},${y0}V${top + h - rr}Q${x0},${top + h} ${x0 + rr},${top + h}H${x1 - rr}Q${x1},${top + h} ${x1},${top + h - rr}V${y0}Z`;
      return `<path class="${v > 0 ? "bu" : "bd2"}" d="${d}"/>`;
    }).join("");
  } else {
    marks = keys.map((k, si) => {
      let d = "", pen = false;
      rows.forEach((r, i) => { if (r[k] == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(r[k]).toFixed(1)}`; pen = true; });
      const last = rows.map((r, i) => [r[k], i]).filter(([v]) => v != null).at(-1);
      const col = c.colors ? c.colors[si] : "var(--accent)";
      return `<path class="ln" style="stroke:${col}" d="${d}"/>` + (last ? `<circle class="ed" cx="${x(last[1])}" cy="${y(last[0])}" r="4" style="fill:${col}"/>` : "");
    }).join("");
  }
  const legend = c.names ? `<span class="tlg">${c.names.map((nm, i) => `<span><i style="background:${c.colors[i]}"></i>${nm}</span>`).join("")}</span>` : "";
  return `<div class="tc" data-ci="${ci}"><h3>${c.t}${legend}</h3><p class="tv" data-tv="${ci}"></p>
    <svg class="tch" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-n="${n}" data-l="${L}" data-bw="${bw}" role="img" aria-label="${c.t}">${g}${marks}
    <line class="xh" data-xh="${ci}" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/><rect class="hit" x="${L}" y="0" width="${pw}" height="${H}"/></svg></div>`;
}
function trValue(c, r) {
  const keys = Array.isArray(c.k) ? c.k : [c.k];
  const v = keys.map((k, i) => r[k] == null ? null : `${c.names ? `<span class="mute2">${c.names[i]}</span> ` : ""}<b>${c.f(r[k])}</b>`);
  return `<span class="mute2">${mdw(r.date)}</span> ` + (v.every(x => x == null) ? '<span class="mute2">當天尚無資料</span>' : v.map(x => x ?? "-").join("　")) + (c.sub && c.sub(r) ? ` <span class="mute2">${c.sub(r)}</span>` : "");
}
function renderTrend() {
  const t = need("trend", ["trend"]);
  if (!t) return '<div class="empty">載入中…</div>';
  if (t.error) return '<div class="empty">趨勢資料尚未產生，之後排程會自動補上。</div>';
  const rows = t.rows.slice(-trState.days);
  // 圖寬：分頁內容寬減掉卡片內距；寬螢幕兩欄
  const cw = (document.querySelector(".scroll")?.clientWidth || 360) - 28, two = window.innerWidth >= 1100;
  const W = Math.max(250, Math.floor((two ? (cw - 10) / 2 : cw) - 26));
  const charts = TR_CHARTS.map((c, i) => trChart(c, rows, W, i)).join("");
  const cols = [["date", "日期"], ["index", "加權指數"], ["fi", "外資現貨(億)"], ["fi_oi", "外資台指淨OI"], ["MTX", "小台散戶%"], ["TMF", "微台散戶%"], ["up", "上漲"], ["down", "下跌"], ["adl", "騰落線"], ["fin_amt", "融資餘額(億)"], ["pc_oi", "P/C(未平倉)%"], ["vix", "VIX"], ["hv20", "歷史波動率%"]];
  const fmt = (k, v) => v == null ? "-" : k === "date" ? md(v) : ["fi", "fi_oi", "MTX", "TMF", "adl"].includes(k) ? `<span class="${cls(v)}">${sg(v, ["fi", "MTX", "TMF"].includes(k) ? 2 : 0)}</span>` : num(v, ["index", "fin_amt", "pc_oi", "vix", "hv20"].includes(k) ? 2 : 0);
  const tbl = `<details class="tv2"><summary>以表格檢視</summary><div class="sc"><table class="ft"><thead><tr>${cols.map(([, h]) => `<th>${h}</th>`).join("")}</tr></thead><tbody>` +
    rows.slice().reverse().map(r => `<tr>${cols.map(([k]) => `<td>${fmt(k, r[k])}</td>`).join("")}</tr>`).join("") + "</tbody></table></div></details>";
  return `<h2 class="sec">趨勢（近 ${rows.length} 個交易日，至 ${t.date}）</h2><div class="sc opt">
    <nav class="optnav">${[20, 60].map(d => btn("data-td", d, `近 ${d} 日`, trState.days === d)).join("")}</nav>
    <p class="mute">點或滑過任一張圖，所有圖會標出同一天並顯示當天數字。外資買賣超、騰落線與指數放在不同圖、同一條日期軸，方便上下對照。</p>
    <div class="tgrid">${charts}</div>${tbl}
    <p class="fn">資料來源：證交所（加權指數、外資買賣超、融資、漲跌家數）、櫃買中心（上櫃融資、漲跌家數）、期交所（外資台指期淨未平倉＝外資及陸資在臺股期貨的多空未平倉淨額；散戶多空比＝（全市場未平倉－法人多單）與（全市場未平倉－法人空單）之差÷全市場未平倉；P/C 比＝賣權未平倉÷買權未平倉）。騰落線從圖上第一天起累計，只看形狀，不看絕對值。融資餘額約晚上 9 點公布，下午時當天會先空著。</p></div>`;
}
function bindTrend(box, charts = TR_CHARTS, rows = null) {
  const t = store.trend;
  if (!t || t.error) return;
  rows = rows || t.rows.slice(-trState.days);
  const show = i => {
    trState.sel = i;
    box.querySelectorAll("svg.tch").forEach(svg => {
      const xh = svg.querySelector(".xh"), xx = +svg.dataset.l + +svg.dataset.bw * (i + 0.5);
      xh.setAttribute("x1", xx); xh.setAttribute("x2", xx); xh.setAttribute("visibility", "visible");
    });
    box.querySelectorAll("[data-tv]").forEach(p => { p.innerHTML = trValue(charts[+p.dataset.tv], rows[i]); });
  };
  box.querySelectorAll("svg.tch").forEach(svg => {
    const pick = e => {
      const r = svg.getBoundingClientRect(), i = Math.floor((e.clientX - r.left - +svg.dataset.l) / +svg.dataset.bw);
      show(Math.max(0, Math.min(rows.length - 1, i)));
    };
    svg.addEventListener("pointermove", pick);
    svg.addEventListener("pointerdown", pick);
  });
  show(trState.sel != null && trState.sel < rows.length ? trState.sel : rows.length - 1);
}
// ---- 選擇權頁的波動率區塊（data/trend.json 的 vix、hv20） ----
const volRows = () => { const t = store.trend; return t && !t.error ? t.rows.slice(-60) : null; };
function renderVol() {
  const t = need("trend", ["opt", "trend", "home"]);
  if (!t) return '<div class="empty">波動率載入中…</div>';
  if (t.error) return "";
  const rows = volRows(), v = rows.map(r => r.vix).filter(x => x != null);
  const last = [...rows].reverse().find(r => r.vix != null);
  if (!last) return "";
  const prev = rows[rows.indexOf(last) - 1], d = prev?.vix != null ? last.vix - prev.vix : null;
  const pr = Math.round(v.filter(x => x < last.vix).length / Math.max(1, v.length - 1) * 100), gap = last.hv20 == null ? null : last.vix - last.hv20;
  const W = Math.max(250, Math.min(900, (document.querySelector(".scroll")?.clientWidth || 360) - 28 - 26));
  return `<h2 class="sec">波動率（台指 VIX，${last.date}）</h2><div class="sc opt">
    <div class="sr vs">
      <div><h3>台指 VIX</h3><p class="big">${num(last.vix, 2)}</p><p class="mute">較前日 <span class="${cls(d)}">${d == null ? "-" : sg(d, 2)}</span><span class="hm">・60 日區間 ${num(Math.min(...v), 2)}～${num(Math.max(...v), 2)}</span>・60 日第 ${pr} 百分位</p></div>
      <div><h3>20 日歷史波動率</h3><p class="big">${last.hv20 == null ? "-" : num(last.hv20, 2) + "%"}</p><p class="mute hm">加權指數近 20 日實際漲跌幅的年化標準差</p></div>
      <div><h3>VIX－歷史波動率</h3><p class="big">${gap == null ? "-" : sg(gap, 2)}</p><p class="mute hm">${gap == null ? "" : gap > 0 ? "選擇權隱含的波動高於實際波動：市場在付較高的保險費（偏恐慌）" : "隱含波動低於實際波動：市場相對安心"}</p></div>
    </div>
    <div class="tgrid one">${trChart(VIX_CHART, rows, W, 0)}</div>
    <p class="fn">台指 VIX：期交所「臺指選擇權波動率指數」，依 CBOE VIX 編製公式，以近月與次近月臺指選擇權價格計算未來 30 天的預期年化波動。數字越高代表市場預期波動越大、通常也越恐慌。歷史波動率由本站用加權指數每日漲跌計算（近 20 日對數報酬標準差 × √252）。點或滑過圖看當天數字。</p></div>`;
}
let trResize = null;
window.addEventListener("resize", () => { clearTimeout(trResize); trResize = setTimeout(() => { if (tab === "trend" || tab === "opt") render(); }, 200); });

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
  set("[data-td]", b => { trState.days = +b.dataset.td; trState.sel = null; });
  box.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  bindTs(box);
  if (tab === "trend") bindTrend(box);
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

const NEW_TABS = { pre: renderPre, news: renderNews, exr: renderExr, sbl: renderSbl, big: renderBig, trend: renderTrend };

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
    box.innerHTML = renderVol() + (data.fut ? renderOpt(data.fut.opt, data.fut.pc, data.fut.date) : '<div class="empty">期交所資料尚未公布，之後排程會自動補上。</div>');
    const vr = volRows();
    if (vr) bindTrend(box, [VIX_CHART], vr);
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
  ["mkt", "大盤", ICON('<path d="M3 20h18"/><path d="M4 16l5-5 4 3 7-8"/>'), [["mkt", "市場強弱"], ["trend", "趨勢"]]],
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

// ---- 今日重點：12 張卡片，點下去到對應分頁；小走勢圖用 data/trend.json ----
function spark(vals, kind = "line") {
  const v = vals.map(x => x ?? null), n = v.length, ok = v.filter(x => x != null);
  if (ok.length < 2) return "";
  let lo = Math.min(...ok), hi = Math.max(...ok);
  if (kind === "bar") { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { lo -= 1; hi += 1; }
  const W = 100, H = 28, y = x => H - 2 - (x - lo) / (hi - lo) * (H - 4), bw = W / n;
  let g = "";
  if (kind === "bar") {
    g = v.map((x, i) => x == null || x === 0 ? "" : `<rect class="${x > 0 ? "bu" : "bd2"}" x="${(i * bw + bw * 0.15).toFixed(2)}" width="${(bw * 0.7).toFixed(2)}" y="${Math.min(y(x), y(0)).toFixed(2)}" height="${Math.max(0.6, Math.abs(y(x) - y(0))).toFixed(2)}"/>`).join("");
  } else {
    let d = "", pen = false;
    v.forEach((x, i) => { if (x == null) { pen = false; return; } d += `${pen ? "L" : "M"}${(i * bw + bw / 2).toFixed(2)},${y(x).toFixed(2)}`; pen = true; });
    g = `<path class="sl2" d="${d}"/>`;
  }
  return `<svg class="spk" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${g}</svg>`;
}
function renderHome() {
  const d = data, mb = d.market_breadth, f = d.fut, s = d.signals;
  const tr = need("trend", ["home"]), ev = need("events", ["home", "pre", "news", "exr"]), pre = need("pre", ["home", "pre"]);
  const rows = tr && !tr.error && tr.rows.at(-1)?.date === d.date ? tr.rows.slice(-20) : null;
  const col = k => rows ? rows.map(r => r[k]) : [];
  const card = (to, title, body, sub = "", sp = "") => `<button class="hc" data-go="${to}"><h3>${title}</h3>${body}${sub ? `<p class="mute">${sub}</p>` : ""}${sp}<span class="more">看詳細 ›</span></button>`;
  const big = (v, cl = "") => `<p class="big ${cl}">${v}</p>`;
  const item = (name, term = "short") => (s?.items || []).find(i => i.term === term && i.name.startsWith(name));
  const cards = [];
  // 1 綜合判讀
  if (s?.terms) {
    const t = s.terms;
    cards.push(card("sig", "綜合判讀", `<p class="vd2"><span>短線</span><b class="${vcls(t.short.verdict)}">${t.short.verdict}</b></p><p class="vd2"><span>中期</span><b class="${vcls(t.mid.verdict)}">${t.mid.verdict}</b></p>`,
      `短線 ${t.short.bull} 多 ${t.short.bear} 空・中期 ${t.mid.bull} 多 ${t.mid.bear} 空（以面向計）`));
  } else cards.push(card("sig", "綜合判讀", big("-"), "綜合分析尚未產生"));
  // 2 加權指數、3 漲跌家數
  if (mb) {
    const x = mb.twse, pct = x.change / (x.index - x.change) * 100, ma = item("加權指數 vs 20 日均線", "mid");
    cards.push(card("trend", "加權指數", big(num(x.index, 2)) + `<p class="${cls(x.change)}">${sg(x.change, 2)}（${sg(pct, 2)}%）</p>`,
      `成交 ${num(x.value, 0)} 億${ma ? `・20 日均線${ma.bias > 0 ? "之上" : "之下"} ${ma.value}` : ""}`, spark(col("index"))));
    const t = mb.trend[mb.trend.length - 1];
    cards.push(card("mkt", "漲跌家數（上市＋上櫃）", `<p class="bd"><span class="up">上漲 ${num(t.up)}</span><span class="down">下跌 ${num(t.down)}</span></p>` +
      `<div class="ratio"><i class="u" style="width:${t.up / (t.up + t.down) * 100}%"></i><i class="d" style="width:${t.down / (t.up + t.down) * 100}%"></i></div>`,
      `騰落 ${sg(t.net)}・近 10 日累計 ${sg(t.adl)}`));
  }
  // 4 外資現貨
  const fi = item("外資現貨"), fi20 = item("外資現貨 20 日累計", "mid");
  if (fi) cards.push(card("fi", "外資現貨（上市）", big(fi.value, fi.value.startsWith("-") ? "down" : "up"), fi20 ? `20 日累計 ${fi20.value}` : fi.detail, spark(col("fi"), "bar")));
  // 5 外資台指期、6 散戶多空比
  if (f) {
    const x = f.inst.find(r => r.name === "外資");
    cards.push(card("fut", "外資台指期淨未平倉", big(sg(x.fut) + " 口", cls(x.fut)), `較前日 ${sg(x.fut_d)} 口・資料 ${f.date}`, spark(col("fi_oi"))));
    const r = f.retail?.rows.find(z => z.code === "MTX"), m = item("小台散戶多空比 60 日位置", "mid");
    if (r) cards.push(card("fut", "小台散戶多空比", big(sg(r.ratio, 2) + "%", cls(r.ratio)),
      `較前日 ${sg(r.ratio_d, 2)} 個百分點${m ? "・" + m.detail.split("，")[1].split("；")[0].replace("目前在", "60 日") : ""}`, spark(col("MTX"))));
  }
  // 7 融資餘額
  const fin = item("融資餘額（上市＋上櫃）"), finm = item("融資餘額 60 日位置", "mid");
  cards.push(card("trend", "融資餘額（上市＋上櫃）", fin ? big(fin.value, cls(parseFloat(fin.value))) : big("-"),
    fin ? `${fin.detail.split("；")[0]}${finm ? "・" + finm.detail.split("，")[1].split("；")[0].replace("目前在", "60 日").replace("目前在", "60 日") : ""}` : "約晚上 9 點公布", spark(col("fin_amt"))));
  // 8 借券賣出
  const sb = s?.sbl;
  cards.push(card("sbl", "借券賣出餘額（全市場）", sb ? big(sg(sb.chg) + " 張", cls(sb.chg)) : big("-"),
    sb ? `餘額 ${num(sb.bal)} 張（${sg(sb.pct, 2)}%）${sb.top.length ? "・增加最多：" + sb.top.map(x => x.name).join("、") : ""}` : "約晚上 9 點後公布"));
  // 9 選擇權結算
  // 系列已依到期日排序且只留資料日之後到期的；到期日已過卻還沒新資料＝遇休市延後結算
  const o = f?.opt?.series?.[0], late = o && o.exp < twToday();
  if (o) cards.push(card("opt", late ? `最近結算 ${o.label}（延後至下一個交易日）` : `最近結算 ${o.label}`,
    `<p class="bd"><span>壓力 <b>${o.resist[0] ? num(o.resist[0].strike) : "-"}</b></span><span>支撐 <b>${o.support[0] ? num(o.support[0].strike) : "-"}</b></span></p>`,
    `加權 ${num(f.opt.ref, 0)}・此系列 P/C ${o.pc == null ? "-" : num(o.pc, 1) + "%"}`));
  // 10 外資買賣超前 3
  const top3 = (rs, t) => rs.slice(0, 3).map(r => `<li><span>${r.name}</span><b class="${cls(r.fi_today)}">${sg(r.fi_today)}</b></li>`).join("") || `<li class="mute">${t}</li>`;
  cards.push(card("fi", "外資買賣超前 3 名（張）",
    `<p class="t3h">買超</p><ol class="t3">${top3(d.fi_buy, "無")}</ol><p class="t3h">賣超</p><ol class="t3">${top3(d.fi_sell, "無")}</ol>`));
  // 11 今日事件
  if (ev && !ev.error) {
    const today = twToday(), hot = hotCodes();
    const nd = ev.news_dates[0], nToday = ev.news.filter(x => x.d === nd), nHot = nToday.filter(x => hot.has(x.code)).length;
    const nextEx = ev.exright.find(x => x.d > today)?.d, exN = nextEx ? ev.exright.filter(x => x.d === nextEx).length : 0;
    cards.push(card("news", "今日事件", `<ul class="evl"><li><span>重大訊息 ${nd ? (nd === today ? "今天" : md(nd)) : ""}</span><b>${nToday.length} 則</b></li><li><span>其中熱門股</span><b>${nHot} 則</b></li>` +
      `<li><span>下次除權息${nextEx ? " " + md(nextEx) : ""}</span><b>${exN} 檔</b></li>${o ? `<li><span>下次結算</span><b>${late ? "延後・" : ""}${o.label.split("（")[0]}</b></li>` : ""}</ul>`));
  } else cards.push(card("news", "今日事件", big("…"), "載入中"));
  // 12 盤前夜盤
  if (pre && !pre.error && pre.date === twToday()) {
    const n = pre.night.find(x => x.code === "TX");
    cards.push(card("pre", "盤前：台指期夜盤", big(num(n.close), cls(n.change)) + `<p class="${cls(n.change)}">${sg(n.change)}（${sg(n.pct, 2)}%）</p>`,
      `更新 ${pre.updated_at.slice(11, 16)}・美元/台幣 ${num(pre.fx[0].values.at(-1), 3)}`));
  } else {
    cards.push(card("pre", "盤前：台指期夜盤", big("-"), pre && !pre.error ? `目前是 ${md(pre.date)} 的盤前資料；交易日早上 07:15 更新` : "交易日早上 07:15 更新"));
  }
  return `<h2 class="sec">今日重點（股票 ${d.date}${f ? `・期貨 ${f.date}` : ""}）</h2><div class="sc opt"><div class="home">${cards.join("")}</div>
    <p class="fn">點卡片看詳細資料。小走勢圖為近 20 個交易日。綜合判讀依固定規則統計各面向訊號，不是預測，也不構成投資建議。</p></div>`;
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
