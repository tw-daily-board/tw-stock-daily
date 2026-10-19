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
const INST_ALL = [["inst", "三大法人合計"]];
const INST_SPLIT = [["fi", "外資"], ["it", "投信"], ["dl", "自營商"]];
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

let data = null, tab = "cap", view = "split", sort = null;

function cols() {
  if (isFi(tab)) {
    const c = BASE.slice();
    c.push({ k: "fi_amt", t: "當日金額(億)", f: v => n(v.toFixed(2)), c: true, g: "外資及陸資", first: true });
    for (const [s, t] of INST_SUB) c.push({ k: `fi_${s}`, t, f: n, c: true, g: "外資及陸資" });
    return c;
  }
  const c = BASE.slice();
  if (tab === "cap") c.splice(9, 0, ...CAP_EXTRA);
  const groups = [];
  for (const [p, g] of (view === "split" ? INST_SPLIT : INST_ALL)) {
    for (const [s, t] of INST_SUB) c.push({ k: `${p}_${s}`, t, f: n, c: true, g, first: s === "today" });
    groups.push(g);
  }
  return c;
}

function tableHtml(key, rows, cs, total) {
  if (sort?.sec === key) {
    const { k, dir } = sort;
    rows = rows.slice().sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k]) : (a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir);
  }
  const plain = cs.filter(c => !c.g).length;
  const grps = isFi(tab) ? [["fi", "外資及陸資"]] : (view === "split" ? INST_SPLIT : INST_ALL);
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
  document.getElementById("view").hidden = isFi(tab) || tab === "fut";
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
