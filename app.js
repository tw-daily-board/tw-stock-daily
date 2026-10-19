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

let data = null, tab = "cap", view = "split", sort = null;

function cols() {
  const c = BASE.slice();
  if (tab === "cap") c.splice(9, 0, ...CAP_EXTRA);
  const groups = [];
  for (const [p, g] of (view === "split" ? INST_SPLIT : INST_ALL)) {
    for (const [s, t] of INST_SUB) c.push({ k: `${p}_${s}`, t, f: n, c: true, g, first: s === "today" });
    groups.push(g);
  }
  return c;
}

function render() {
  const tbl = document.getElementById("tbl");
  const cs = cols();
  let rows = data[tab].slice();
  if (sort) {
    const { k, dir } = sort;
    rows.sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k]) : (a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir);
  }
  const plain = cs.filter(c => !c.g).length;
  const groupRow = "<tr>" + `<th class="plain" colspan="${plain}"></th>` +
    (view === "split" ? INST_SPLIT : INST_ALL).map(([, g]) => `<th class="grp" colspan="3">${g}（張）</th>`).join("") + "</tr>";
  const th = c => `<th data-k="${c.k}" class="${c.first ? "gl " : ""}${sort?.k === c.k ? (sort.dir > 0 ? "asc" : "desc") : ""}">${c.t}</th>`;
  const body = rows.map(r => "<tr>" + cs.map(c => {
    const v = r[c.k];
    const txt = c.f ? (v == null ? "-" : c.f(v)) : v;
    const klass = [c.c ? cls(v) : "", c.k === "name" ? "name" : "", c.first ? "gl" : ""].join(" ");
    return `<td class="${klass}">${txt}</td>`;
  }).join("") + "</tr>").join("");
  tbl.innerHTML = `<thead>${groupRow}<tr>${cs.map(th).join("")}</tr></thead><tbody>${body}</tbody>`;
  tbl.querySelectorAll("th[data-k]").forEach(el => el.onclick = () => {
    const k = el.dataset.k;
    sort = sort?.k === k ? { k, dir: -sort.dir } : { k, dir: ["rank", "code", "name", "market"].includes(k) ? 1 : -1 };
    render();
  });
}

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
    document.getElementById("meta").textContent =
      `資料日期 ${j.date}（${j.market}）・更新時間 ${j.updated_at.replace("T", " ").slice(0, 16)}`;
    render();
  })
  .catch(() => {
    document.getElementById("meta").textContent = "";
    document.querySelector(".scroll").innerHTML =
      '<div class="empty">尚無資料。請先執行 scripts/fetch_data.py，或等待排程第一次更新。</div>';
  });
