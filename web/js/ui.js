// Componentes visuais e regras de preço usadas em várias telas.
import { esc, brl, pct, todayIso, addDays, daysBetween, parseDate, isoOf, WD, MONTHS, median } from "./core.js";
import { icon } from "./icons.js";

export const pill = (text, tone = "", extra = "") => `<span class="pill ${tone} ${extra}">${text}</span>`;
export const secTitle = (title, action = "", id = "") => `<div class="sec-title"${id ? ` id="${id}"` : ""}><h2>${title}</h2>${action}</div>`;
export const back = (href, label) => `<a class="back" href="${href}">${icon("arrow-left", 16)}${esc(label)}</a>`;
export const seg = (id, options, value) =>
  `<div class="seg" id="${id}">${options.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${v === value ? "on" : ""}">${l}</button>`).join("")}</div>`;
export function bindSeg(id, onChange) {
  const el = document.getElementById(id);
  el?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onChange(b.dataset.v);
  });
}

// termômetro: barato ← normal → caro
export function thermo(price, normal, compact = false) {
  if (!normal || price == null) return "";
  const pos = Math.max(4, Math.min(96, 50 + ((Number(price) - Number(normal)) / Number(normal)) * 200));
  return `<div><div class="thermo-bar"><i style="left:${pos.toFixed(1)}%"></i></div>${compact ? "" : `<div class="thermo-labels"><span>barato</span><span>normal</span><span>caro</span></div>`}</div>`;
}

export function sparkline(values) {
  const v = values.slice(-10);
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v);
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * 100).toFixed(1)},${(28 - ((x - min) / (max - min || 1)) * 24).toFixed(1)}`).join(" ");
  const color = v[v.length - 1] > v[0] ? "var(--bad)" : "var(--good)";
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

export function changePill(change) {
  if (!change) return pill("= estável");
  return change.diff < 0
    ? pill(`${icon("arrow-down", 12)} ${brl(-change.diff)} desde ontem`, "good")
    : pill(`${icon("arrow-up", 12)} ${brl(change.diff)} desde ontem`, "bad");
}
export function changeArrow(change) {
  if (!change || change.diff === 0) return `<span class="xs muted" style="width:20px;text-align:center">=</span>`;
  return change.diff < 0 ? `<span class="good-t">${icon("arrow-down", 16)}</span>` : `<span class="bad-t">${icon("arrow-up", 16)}</span>`;
}

// variação do menor preço em relação a ~24 h atrás
export function dayChange(points) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const ref = [...points].reverse().find((p) => last.t - p.t >= 20 * 3600000);
  if (!ref) return null;
  return { diff: Math.round(last.y - ref.y) };
}

// ---------------------------------------------------------------------------
// "Devo comprar agora?"
// ---------------------------------------------------------------------------
export function buyVerdict(price, normal, low, startIso) {
  if (price == null) return null;
  const left = startIso ? daysBetween(todayIso(), startIso) : null;
  const mk = (tone, emoji, title, text) => ({ tone, emoji, title, text });
  if (!normal) return mk("", "⚪", "Ainda aprendendo", "Preciso de mais algumas verificações para entender o preço normal.");
  const p = pct(Number(price), Number(normal));
  const nearLow = low != null && Number(price) <= low * 1.02;
  if (p >= 10 || nearLow) return mk("good", "🟢", "Bom momento para comprar", nearLow ? `É o menor preço que o robô já viu${p > 0 ? `, ${Math.round(p)}% abaixo do normal` : ""}.` : `O preço está ${Math.round(p)}% abaixo do normal.`);
  if (left != null && left <= 21) {
    return p >= -5
      ? mk("good", "🟢", "Compre logo", `Preço bom e a viagem está chegando (faltam ${left} dias): esperar fica arriscado.`)
      : mk("bad", "🔴", "Caro, e a data está chegando", `Está ${Math.round(-p)}% acima do normal e faltam só ${left} dias. Considere comprar mesmo assim ou mudar as datas.`);
  }
  if (p <= -8) return mk("bad", "🔴", "Caro: dá para esperar", `Está ${Math.round(-p)}% acima do normal.${left ? ` Faltam ${left} dias: ainda há tempo para cair.` : ""}`);
  return mk("warn", "🟡", "Pode esperar", `Preço dentro do normal${left ? ` e ainda faltam ${left} dias` : ""}. O robô avisa se cair.`);
}
export const verdictPill = (v) => (v ? pill(`${v.emoji} ${esc(v.title)}`, v.tone) : "");
export const verdictCard = (v) => (v ? `<div class="card verdict"><span class="verdict-ic ${v.tone}">${v.emoji}</span><div class="grow">
    <p class="eyebrow">Devo comprar agora?</p><h3 class="lg b">${esc(v.title)}</h3><p class="sm muted">${esc(v.text)}</p></div></div>` : "");

// ---------------------------------------------------------------------------
// Datas das rotas
// ---------------------------------------------------------------------------
export function tripStart(r, best) {
  if (best?.depart_date) return best.depart_date;
  return r.date_mode === "fixed" ? r.depart_date : r.date_mode === "long" ? r.depart_from : r.month;
}
export const daysLeft = (iso) => (iso ? daysBetween(todayIso(), iso) : null);
export function countdownText(iso) {
  const n = daysLeft(iso);
  return n == null ? "" : n > 1 ? `faltam ${n} dias` : n === 1 ? "é amanhã!" : n === 0 ? "é hoje!" : "";
}
export function tripRange(r) {
  if (r.date_mode === "fixed") return [r.depart_date, r.return_date || addDays(r.depart_date, 7)];
  if (r.date_mode === "month") { const d = parseDate(r.month); return [r.month, isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0))]; }
  return [r.depart_from, addDays(r.depart_to, r.max_stay || 30)];
}
// datas sugeridas para hotel: a viagem da rota (no mês inteiro, os dias de viagem a partir do 1º dia possível)
export function stayRange(r) {
  const tomorrow = addDays(todayIso(), 1);
  if (r.date_mode === "fixed") return [r.depart_date, r.return_date || addDays(r.depart_date, 7)];
  if (r.date_mode === "month") { const a = r.month > tomorrow ? r.month : tomorrow; return [a, addDays(a, Math.min(30, r.stay_days || 7))]; }
  const a = r.depart_from > tomorrow ? r.depart_from : tomorrow;
  return [a, addDays(a, 7)];
}
export function longWindows(r) {
  const tomorrow = addDays(todayIso(), 1);
  const outFrom = r.depart_from > tomorrow ? r.depart_from : tomorrow;
  const w = { outFrom, outTo: r.depart_to };
  if (r.trip_type === "round_trip" && outFrom <= r.depart_to) {
    w.backFrom = addDays(outFrom, r.min_stay || 1);
    w.backTo = addDays(r.depart_to, r.max_stay);
  }
  return w;
}
export const stayOk = (r, dep, ret) => { const n = daysBetween(dep, ret); return n >= (r.min_stay || 1) && n <= r.max_stay; };
export function inScopeLong(r, row) {
  const w = longWindows(r);
  if (row.leg === "back") return !!w.backFrom && row.depart_date >= w.backFrom && row.depart_date <= w.backTo;
  if (row.depart_date < w.outFrom || row.depart_date > w.outTo) return false;
  if (row.leg === "out") return true;
  return !!row.return_date && stayOk(r, row.depart_date, row.return_date);
}
// só considera preços das datas que a rota acompanha hoje
export function inScope(r, row) {
  if (r.date_mode === "long") return inScopeLong(r, row);
  if (row.leg || row.depart_date < todayIso()) return false;
  if (r.date_mode === "fixed") return row.depart_date === r.depart_date && (r.trip_type === "one_way" ? !row.return_date : row.return_date === r.return_date);
  if (row.depart_date.slice(0, 7) !== r.month.slice(0, 7)) return false;
  if (r.trip_type === "one_way") return !row.return_date;
  return row.return_date && daysBetween(row.depart_date, row.return_date) === r.stay_days;
}
export const lastCheck = (rows) => { const at = rows.reduce((a, b) => (b.checked_at > a ? b.checked_at : a), ""); return rows.filter((x) => x.checked_at === at); };
export const cheapest = (rows) => rows.reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null);

export function summary(r) {
  const kind = r.trip_type === "round_trip" ? "Ida e volta" : "Só ida";
  const pax = ` · ${r.adults} adulto${r.adults > 1 ? "s" : ""}`;
  const stops = r.max_stops === 0 ? " · só direto" : "";
  const fs = (iso) => { const d = parseDate(iso); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`; };
  if (r.date_mode === "fixed") return `${kind} · ${r.trip_type === "round_trip" ? `${fs(r.depart_date)} → ${fs(r.return_date)}` : fs(r.depart_date)}${pax}${stops}`;
  if (r.date_mode === "long") return `Viagem longa · ida ${fs(r.depart_from)}–${fs(r.depart_to)}${r.trip_type === "round_trip" ? ` · ${r.min_stay || 1} a ${r.max_stay} dias` : ""}${pax}`;
  const d = parseDate(r.month);
  return `${kind} · ${MONTHS[d.getMonth()]} ${d.getFullYear()} inteiro${r.trip_type === "round_trip" ? ` · ${r.stay_days} dias` : ""}${pax}${stops}`;
}

export function googleUrl(r, dep, ret, back = false) {
  const [from, to] = back ? [r.destination, r.origin] : [r.origin, r.destination];
  const text = `Flights from ${from} to ${to} on ${dep}` + (ret ? ` through ${ret}` : " one way") + (r.adults > 1 ? ` for ${r.adults} adults` : "");
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(text)}&hl=pt-BR&curr=BRL`;
}

// ---------------------------------------------------------------------------
// Gráfico do histórico (30 dias): área, linha do preço normal e ponto mínimo
// ---------------------------------------------------------------------------
export function priceChart(points, normal) {
  const data = points.map((p) => p.y);
  if (data.length < 2) return `<p class="sm muted" style="padding:24px 0;text-align:center">O gráfico aparece depois de algumas verificações.</p>`;
  const lo = Math.min(...data, normal || Infinity) * 0.95, hi = Math.max(...data, normal || 0) * 1.03;
  const x = (i) => (i / (data.length - 1)) * 320, y = (v) => 140 - ((v - lo) / (hi - lo || 1)) * 140;
  const d = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const iMin = data.indexOf(Math.min(...data));
  return `<svg class="chart" viewBox="0 0 320 150" role="img" aria-label="Histórico do menor preço">
    <defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--primary)" stop-opacity=".25"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>
    <path d="${d} L320,140 L0,140 Z" fill="url(#area)"/>
    ${normal ? `<line x1="0" x2="320" y1="${y(normal).toFixed(1)}" y2="${y(normal).toFixed(1)}" stroke="var(--muted-foreground)" stroke-width="1.5" stroke-dasharray="5 5"/>
    <text x="320" y="${(y(normal) - 6).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="var(--muted-foreground)">normal ${brl(normal)}</text>` : ""}
    <path d="${d}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(iMin).toFixed(1)}" cy="${y(data[iMin]).toFixed(1)}" r="5" fill="var(--good)" stroke="var(--card)" stroke-width="2.5"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Calendário de preços (vários meses); group separa calendários na mesma tela
// ---------------------------------------------------------------------------
export function calendarRange(fromIso, toIso, byDay, normalOf, bestIso, group = "") {
  const today = todayIso();
  const end = parseDate(toIso);
  let out = "";
  for (let cur = parseDate(fromIso.slice(0, 8) + "01"); cur <= end; cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)) {
    const y = cur.getFullYear(), m = cur.getMonth();
    let html = ["D", "S", "T", "Q", "Q", "S", "S"].map((w) => `<span>${w}</span>`).join("") + `<span></span>`.repeat(cur.getDay());
    for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++) {
      const iso = isoOf(new Date(y, m, d));
      const row = byDay[iso];
      if (iso <= today || iso < fromIso || iso > toIso) { html += `<span class="day past"><span class="n">${d}</span></span>`; continue; }
      if (!row) { html += `<span class="day none"><span class="n">${d}</span><span class="p">–</span></span>`; continue; }
      const n = normalOf(row);
      const ratio = n ? Number(row.price) / n : 1;
      const cls = ratio < 0.95 ? "good" : ratio < 1.05 ? "" : ratio < 1.12 ? "warn" : "bad";
      html += `<button type="button" class="day pressable ${cls} ${bestIso === iso ? "sel" : ""}" data-d="${iso}"><span class="n">${d}</span><span class="p">${(Number(row.price) / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k</span></button>`;
    }
    out += `<p class="cal-month">${MONTHS[m]} ${y}</p><div class="cal" data-g="${group}">${html}</div>`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversor de moedas (cotação do dia em open.er-api.com)
// ---------------------------------------------------------------------------
const CURRENCIES = [["BRL", "🇧🇷"], ["USD", "🇺🇸"], ["EUR", "🇪🇺"], ["ARS", "🇦🇷"], ["CLP", "🇨🇱"], ["UYU", "🇺🇾"], ["GBP", "🇬🇧"], ["COP", "🇨🇴"], ["PEN", "🇵🇪"], ["MXN", "🇲🇽"], ["EGP", "🇪🇬"], ["JPY", "🇯🇵"], ["CHF", "🇨🇭"], ["CAD", "🇨🇦"]];
const FALLBACK = { BRL: 1, USD: 0.18, EUR: 0.164, ARS: 200, CLP: 170, UYU: 7.2, GBP: 0.14, COP: 720, PEN: 0.67, MXN: 3.4, EGP: 8.9, JPY: 27, CHF: 0.15, CAD: 0.25 };
let liveRates = null;
async function rates() {
  if (liveRates) return liveRates;
  try {
    const j = await (await fetch("https://open.er-api.com/v6/latest/BRL")).json();
    if (j?.rates) liveRates = { ...FALLBACK, ...j.rates };
  } catch {}
  return liveRates;
}
export function converter(id, defaultTo = "EUR") {
  const list = CURRENCIES.some(([c]) => c === defaultTo) ? CURRENCIES : [...CURRENCIES, [defaultTo, "🏳️"]];
  const opts = (sel) => list.map(([c, f]) => `<option value="${c}" ${c === sel ? "selected" : ""}>${f} ${c}</option>`).join("");
  return `<div class="conv" id="${id}" data-to="${esc(defaultTo)}">
    <div class="row"><input class="conv-amount" inputmode="decimal" aria-label="Valor" value="1000"><select aria-label="De" data-k="from">${opts("BRL")}</select></div>
    <div class="row"><button type="button" class="conv-swap pressable" aria-label="Inverter moedas">${icon("arrow-left-right", 16)}</button><p class="conv-result">–</p><select aria-label="Para" data-k="to">${opts(defaultTo)}</select></div>
    <p class="tiny muted" data-k="note"></p>
  </div>`;
}
export function bindConverter(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const amount = el.querySelector(".conv-amount"), from = el.querySelector('[data-k="from"]'), to = el.querySelector('[data-k="to"]');
  let r = FALLBACK, live = false;
  const fmt = (x) => x.toLocaleString("pt-BR", { maximumFractionDigits: x < 10 ? 2 : 0 });
  const conv = (v, a, b) => (!r[a] || !r[b] ? 0 : (v / r[a]) * r[b]);
  const draw = () => {
    const v = parseFloat(amount.value.replace(/\./g, "").replace(",", ".")) || 0;
    el.querySelector(".conv-result").textContent = fmt(conv(v, from.value, to.value));
    const unit = to.value === "BRL" ? from.value : to.value;
    el.querySelector('[data-k="note"]').textContent = unit === "BRL" ? (live ? "cotação de hoje" : "cotação aproximada") : `1 ${unit} = R$ ${fmt(conv(1, unit, "BRL"))} · ${live ? "cotação de hoje" : "cotação aproximada"}`;
  };
  amount.addEventListener("input", draw);
  from.addEventListener("change", draw);
  to.addEventListener("change", draw);
  el.querySelector(".conv-swap").addEventListener("click", () => { [from.value, to.value] = [to.value, from.value]; draw(); });
  draw();
  rates().then((x) => { if (x) { r = x; live = true; draw(); } });
}

// ---------------------------------------------------------------------------
// Autocomplete de cidades/aeroportos (Travelpayouts)
// ---------------------------------------------------------------------------
export function autocomplete(input, list, onPick, types = ["city", "airport"]) {
  let timer, seq = 0, items = [];
  const labelOf = (it) => (it.type === "city" ? it.name : it.city_name || it.name);
  const subOf = (it) => (it.type === "city" ? `todos os aeroportos · ${it.country_name}` : `${it.name} · ${it.country_name}`);
  const close = () => (list.hidden = true);
  const pick = (it) => { close(); onPick({ ...it, label: labelOf(it), sub: subOf(it), cityCode: it.type === "airport" ? it.city_code || it.code : it.code }); };
  list.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button[data-i]"); if (!b) return;
    e.preventDefault(); pick(items[Number(b.dataset.i)]);
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) { items = []; close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const url = `https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(term)}&locale=pt${types.map((t) => `&types[]=${t}`).join("")}`;
        const found = (await (await fetch(url)).json()).slice(0, 8);
        if (my !== seq) return;
        items = found;
        list.innerHTML = items.length
          ? items.map((it, i) => `<button type="button" data-i="${i}"><span class="code">${esc(it.code)}</span><span class="grow"><b>${esc(labelOf(it))}</b><br><span class="tiny muted">${esc(subOf(it))}</span></span></button>`).join("")
          : `<p class="sm muted" style="padding:10px">Nada encontrado. Tente outro nome ou o código de 3 letras (ex.: GRU).</p>`;
        list.hidden = document.activeElement !== input;
      } catch { close(); }
    }, 200);
  });
  input.addEventListener("focus", () => { if (items.length) list.hidden = false; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && items.length && !list.hidden) { e.preventDefault(); pick(items[0]); }
    if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  return { first: () => items[0] && pick(items[0]), hasItems: () => items.length > 0 };
}

export { WD, median };
