const COLS = [
  { k: "rank",   t: "#" },
  { k: "code",   t: "代號" },
  { k: "name",   t: "名稱" },
  { k: "close",  t: "收盤價", f: v => v.toFixed(2) },
  { k: "change", t: "漲跌", f: v => signed(v.toFixed(2), v), c: true },
  { k: "pct",    t: "漲跌幅", f: v => signed(v.toFixed(2) + "%", v), c: true },
  { k: "volume", t: "成交量(張)", f: v => v.toLocaleString() },
  { k: "value",  t: "成交金額(億)", f: v => (v / 1e8).toFixed(2) },
  { k: "inst_today", t: "法人買賣超<br>當日(張)", f: n, c: true },
  { k: "inst_prev",  t: "法人買賣超<br>前日(張)", f: n, c: true },
  { k: "inst_10d",   t: "法人買賣超<br>10日合計(張)", f: n, c: true },
];
const CAP_EXTRA = [
  { k: "mktcap", t: "市值(億)", f: v => v.toLocaleString() },
  { k: "weight", t: "占大盤", f: v => v.toFixed(2) + "%" },
];

function signed(s, v) { return v > 0 ? "+" + s : s; }
function n(v) { return v == null ? "-" : signed(v.toLocaleString(), v); }
const cls = v => (v > 0 ? "up" : v < 0 ? "down" : "");

let data = null, tab = "cap", sort = null;

function cols() {
  if (tab !== "cap") return COLS;
  const c = COLS.slice();
  c.splice(8, 0, ...CAP_EXTRA);
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
  const head = cs.map(c => `<th data-k="${c.k}" class="${sort?.k === c.k ? (sort.dir > 0 ? "asc" : "desc") : ""}">${c.t}</th>`).join("");
  const body = rows.map(r => "<tr>" + cs.map(c => {
    const v = r[c.k];
    const txt = c.f ? (v == null ? "-" : c.f(v)) : v;
    const klass = [c.c ? cls(v) : "", c.k === "name" ? "name" : ""].join(" ");
    return `<td class="${klass}">${txt}</td>`;
  }).join("") + "</tr>").join("");
  tbl.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  tbl.querySelectorAll("th").forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    sort = sort?.k === k ? { k, dir: -sort.dir } : { k, dir: k === "rank" || k === "code" || k === "name" ? 1 : -1 };
    render();
  });
}

document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x === b));
  tab = b.dataset.t; sort = null;
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
