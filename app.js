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
    <p class="fn">每項依固定門檻判讀：外資現貨 ±30 億、投信 ±10 億、騰落 ±200 家、外資台指與十大特定法人變化 ±1,000 口、外資選擇權淨金額 ±0.5 億、P/C 比較前 5 日平均 ±5 個百分點、台積電外資 ±1,000 張、前 20 大權值股外資合計 ±5,000 張；量能放量（20 日量比 ≥1.2）時依漲跌判讀；融資在指數下跌時增加視為偏空、在指數上漲時減少視為偏多。偏多與偏空項數相差 3 項以上才判為偏多或偏空，否則為多空互見。此為規則統計，不是預測，也不構成投資建議。</p></div>`;
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
    ftable("十大交易人期權淨部位（口）", ["", "十大(特定人) 近月", "十大(特定人) 其他月", "十大(非特定人) 近月", "十大(非特定人) 其他月", "全市場OI"], large,
      '<p class="fn">淨部位＝十大買方部位－十大賣方部位；特定人＝特定法人，非特定人＝其餘交易人；近月為最近月份契約，其他月含週契約；括號為較前一交易日的變化。</p>');
}

function render() {
  const box = document.querySelector(".scroll");
  const cs = cols();
  document.getElementById("view").hidden = isFi(tab) || ["fut", "opt", "mkt", "sig"].includes(tab);
  if (tab === "mkt") { box.innerHTML = renderMarket(data.market_breadth); return; }
  if (tab === "sig") { box.innerHTML = renderSignals(data.signals); return; }
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
