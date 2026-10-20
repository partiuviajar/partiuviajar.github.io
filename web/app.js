import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY, MAX_ROUTES } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const $view = document.getElementById("view");
const $tabs = document.getElementById("tabs");
const $bot = document.getElementById("bot-status");
let session = null;
let renderSeq = 0;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const brl = (v) => (v == null ? "–" : "R$ " + Math.round(Number(v)).toLocaleString("pt-BR"));
const compactBrl = (v) => {
  const n = Math.round(Number(v));
  return n >= 10000 ? (n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k" : n.toLocaleString("pt-BR");
};
const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const parseDate = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => isoOf(new Date());
const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const fmtDay = (iso) => { const d = parseDate(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} (${WD[d.getDay()]})`; };
const fmtShort = (iso) => { const d = parseDate(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
const fmtMonth = (iso) => { const d = parseDate(iso); return `${MONTHS[d.getMonth()]} de ${d.getFullYear()}`; };
const fmtDateTime = (ts) => new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function ago(ts) {
  if (!ts) return "nunca";
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `há ${d} dia${d > 1 ? "s" : ""}`;
}

let toastTimer;
function toast(msg, ms = 3200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function friendlyError(error) {
  const m = error?.message || String(error);
  if (/Limite de \d+ rotas/.test(m)) return `Você já tem ${MAX_ROUTES} rotas ativas. Pause ou apague uma antes.`;
  if (/row-level security|permission denied/i.test(m)) return "Este e-mail não tem permissão para usar o app. Entre com o e-mail do dono.";
  if (/Invalid login credentials/i.test(m)) return "E-mail ou senha incorretos.";
  if (/already registered/i.test(m)) return "Esse e-mail já tem conta. Use “Entrar”.";
  if (/Email not confirmed/i.test(m)) return "Confirme seu e-mail pelo link que enviamos e tente de novo.";
  if (/Password should be/i.test(m)) return "A senha precisa ter pelo menos 6 caracteres.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão. Verifique a internet.";
  return m;
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

const pct = (price, normal) => (normal ? ((normal - price) / normal) * 100 : null);
function level(price, normal, thr) {
  const p = pct(price, normal);
  if (p == null) return { cls: "", label: "aprendendo o preço normal" };
  if (p >= thr) return { cls: "good", label: `🔥 ${Math.round(p)}% abaixo do normal` };
  if (p >= 5) return { cls: "good", label: `${Math.round(p)}% abaixo do normal` };
  if (p > -8) return { cls: "", label: "preço normal" };
  if (p > -20) return { cls: "warn", label: `${Math.round(-p)}% acima do normal` };
  return { cls: "bad", label: `${Math.round(-p)}% acima do normal` };
}

const stopsLabel = (s) => (s == null ? "" : s === 0 ? "direto" : `${s} escala${s > 1 ? "s" : ""}`);
const sourceLabel = (s) => (s === "google" ? "Google Flights" : s === "aviasales" ? "Aviasales" : s || "");
const place = (r, which) => r[`${which}_label`] || r[which];

function tripLabel(r) {
  const kind = r.trip_type === "round_trip" ? "Ida e volta" : "Só ida";
  const pax = r.adults > 1 ? ` · ${r.adults} adultos` : "";
  const stops = r.max_stops === 0 ? " · só direto" : r.max_stops ? ` · até ${r.max_stops} escala${r.max_stops > 1 ? "s" : ""}` : "";
  if (r.date_mode === "fixed") {
    const dates = r.trip_type === "round_trip" ? `${fmtDay(r.depart_date)} → ${fmtDay(r.return_date)}` : fmtDay(r.depart_date);
    return `${kind} · ${dates}${pax}${stops}`;
  }
  if (r.date_mode === "long") {
    const back = r.trip_type === "round_trip" ? ` · volta ${r.min_stay || 1} a ${r.max_stay} dias depois` : "";
    const direct = r.track_direct ? " · diretos à parte" : "";
    return `Viagem longa · ida ${fmtShort(r.depart_from)} a ${fmtShort(r.depart_to)}${back}${pax}${stops}${direct}`;
  }
  const stay = r.trip_type === "round_trip" ? ` · ${r.stay_days} dias de viagem` : "";
  return `${kind} · ${fmtMonth(r.month)} inteiro${stay}${pax}${stops}`;
}

// Período da viagem (para o clima nas suas datas)
function tripRange(r) {
  if (r.date_mode === "fixed") return [r.depart_date, r.return_date || addDays(r.depart_date, 7)];
  if (r.date_mode === "month") { const d = parseDate(r.month); return [r.month, isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0))]; }
  return [r.depart_from, addDays(r.depart_to, r.max_stay || 30)];
}

// Viagem longa: dias de ida e de volta acompanhados (só no futuro)
function longWindows(r) {
  const tomorrow = addDays(todayIso(), 1);
  const outFrom = r.depart_from > tomorrow ? r.depart_from : tomorrow;
  const w = { outFrom, outTo: r.depart_to };
  if (r.trip_type === "round_trip" && outFrom <= r.depart_to) {
    w.backFrom = addDays(outFrom, r.min_stay || 1);
    w.backTo = addDays(r.depart_to, r.max_stay);
  }
  return w;
}
const stayOk = (r, dep, ret) => { const n = daysBetween(dep, ret); return n >= (r.min_stay || 1) && n <= r.max_stay; };

function inScopeLong(r, row) {
  const w = longWindows(r);
  if (row.leg === "back") return !!w.backFrom && row.depart_date >= w.backFrom && row.depart_date <= w.backTo;
  if (row.depart_date < w.outFrom || row.depart_date > w.outTo) return false;
  if (row.leg === "out") return true;
  return !!row.return_date && stayOk(r, row.depart_date, row.return_date);
}

// Só considera preços das datas que a rota acompanha hoje (se você editou as datas, ignora as antigas)
function inScope(r, row) {
  if (r.date_mode === "long") return inScopeLong(r, row);
  if (row.leg || row.depart_date < todayIso()) return false;
  if (r.date_mode === "fixed") {
    return row.depart_date === r.depart_date && (r.trip_type === "one_way" ? !row.return_date : row.return_date === r.return_date);
  }
  if (row.depart_date.slice(0, 7) !== r.month.slice(0, 7)) return false;
  if (r.trip_type === "one_way") return !row.return_date;
  return row.return_date && daysBetween(row.depart_date, row.return_date) === r.stay_days;
}

function googleUrl(r, dep, ret, back = false) {
  const [from, to] = back ? [r.destination, r.origin] : [r.origin, r.destination];
  const text = `Flights from ${from} to ${to} on ${dep}` + (ret ? ` through ${ret}` : " one way") + (r.adults > 1 ? ` for ${r.adults} adults` : "");
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(text)}&hl=pt-BR&curr=BRL`;
}

// ---------------------------------------------------------------------------
// Gráficos (SVG feito à mão, sem bibliotecas)
// ---------------------------------------------------------------------------
function sparkline(values) {
  if (values.length < 2) return "";
  const w = 300, h = 44, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" stroke="var(--brand)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function lineChart(points) {
  // points: [{t: Date, y: number, n: number|null}]
  if (points.length < 2) return `<div class="empty small">O gráfico aparece depois de algumas verificações.</div>`;
  const W = 340, H = 200, L = 44, R = 10, T = 12, B = 24;
  const ys = points.flatMap((p) => [p.y, p.n].filter((v) => v != null));
  let min = Math.min(...ys), max = Math.max(...ys);
  const padY = (max - min) * 0.12 || max * 0.05 || 1;
  min -= padY; max += padY;
  const t0 = points[0].t.getTime(), t1 = points[points.length - 1].t.getTime(), tspan = t1 - t0 || 1;
  const x = (t) => L + ((t.getTime() - t0) / tspan) * (W - L - R);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.y).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points[points.length - 1].t).toFixed(1)} ${H - B} L${x(points[0].t).toFixed(1)} ${H - B} Z`;
  const normals = points.filter((p) => p.n != null);
  const normalLine = normals.length > 1 ? normals.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.n).toFixed(1)}`).join(" ") : "";
  const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f);
  const grid = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${compactBrl(v)}</text>`).join("");
  const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  const last = points[points.length - 1];
  const lowest = points.reduce((a, b) => (b.y < a.y ? b : a));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Histórico do menor preço">
    ${grid}
    <path class="area" d="${area}"/>
    ${normalLine ? `<path class="normal" d="${normalLine}"/>` : ""}
    <path class="line" d="${line}"/>
    <circle class="dot" cx="${x(lowest.t)}" cy="${y(lowest.y)}" r="4" style="fill:var(--good)"/>
    <circle class="dot" cx="${x(last.t)}" cy="${y(last.y)}" r="4.5"/>
    <text class="axis" x="${L}" y="${H - 6}">${fmt(points[0].t)}</text>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${fmt(last.t)}</text>
  </svg>
  <div class="legend"><span><i></i>menor preço</span>${normalLine ? `<span><i class="dash"></i>preço normal</span>` : ""}<span>● verde = mais barato do período (${brl(lowest.y)})</span></div>`;
}

// ---------------------------------------------------------------------------
// Fotos, termômetro, "devo comprar?", contagem regressiva
// ---------------------------------------------------------------------------
// miniaturas da Wikimedia aceitam alguns tamanhos fixos (330, 500, 960…)
const photo = (d, size = 500) => d?.thumb ? d.thumb.replace(/\/\d+px-/, `/${size}px-`) : null;
const bgPhoto = (url) => (url ? `style="background-image:url('${esc(url)}')"` : "");

async function loadDestinations(codes, cols = "code,name,country_code,country_name,thumb") {
  const uniq = [...new Set(codes.filter(Boolean))];
  if (!uniq.length) return {};
  try {
    const rows = await q(sb.from("destinations").select(cols).in("code", uniq));
    return Object.fromEntries(rows.map((r) => [r.code, r]));
  } catch { return {}; }
}

// primeiro dia da viagem (para a contagem regressiva)
function tripStart(r, best) {
  if (best?.depart_date) return best.depart_date;
  return r.date_mode === "fixed" ? r.depart_date : r.date_mode === "long" ? r.depart_from : r.month;
}
function countdown(iso) {
  if (!iso) return "";
  const n = daysBetween(todayIso(), iso);
  return n > 1 ? `✈️ faltam ${n} dias` : n === 1 ? "✈️ é amanhã!" : n === 0 ? "✈️ é hoje!" : "";
}

// termômetro: barato ← normal → caro, com o ponteiro no preço de hoje
function thermo(price, normal) {
  if (!normal || price == null) return "";
  const p = (Number(price) / Number(normal) - 1) * 100;
  const pos = Math.max(3, Math.min(97, 50 + p * 1.6));
  return `<div class="thermo" aria-label="Preço em relação ao normal"><div class="thermo-bar"><i style="left:${pos.toFixed(1)}%"></i></div>
    <div class="thermo-labels"><span>barato</span><span>normal</span><span>caro</span></div></div>`;
}

// variação do menor preço em relação a ~24 h atrás
function dayChange(points) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const ref = [...points].reverse().find((p) => last.t - p.t >= 20 * 3600000);
  if (!ref) return null;
  const diff = last.y - ref.y;
  if (Math.abs(diff) < 1) return { cls: "", text: "= igual a ontem" };
  return diff < 0 ? { cls: "good", text: `↓ ${brl(-diff)} desde ontem` } : { cls: "bad", text: `↑ ${brl(diff)} desde ontem` };
}

// "Devo comprar agora?": histórico + quanto falta para a viagem
function buyVerdict(price, normal, low, startIso) {
  if (price == null) return null;
  const left = startIso ? daysBetween(todayIso(), startIso) : null;
  const mk = (cls, icon, title, text) => ({ cls, icon, title, text });
  if (!normal) return mk("", "⚪", "Ainda aprendendo", "O robô precisa de mais alguns dias de preços para dizer se vale a pena.");
  const p = pct(Number(price), Number(normal));
  const nearLow = low != null && Number(price) <= low * 1.02;
  if (p >= 10 || nearLow) return mk("good", "🟢", "Bom momento para comprar", nearLow ? "É o menor preço que o robô já viu para esta viagem." : `Está ${Math.round(p)}% abaixo do normal.`);
  if (left != null && left <= 21) {
    return p >= -5
      ? mk("good", "🟢", "Compre logo", `Faltam ${left} dias: perto da data os preços costumam subir.`)
      : mk("bad", "🔴", "Caro, e a data está chegando", `Está ${Math.round(-p)}% acima do normal, mas faltam só ${left} dias. Esperar é arriscado.`);
  }
  if (p <= -8) return mk("bad", "🔴", "Caro: dá para esperar", `Está ${Math.round(-p)}% acima do normal${left ? ` e faltam ${left} dias` : ""}. O robô avisa quando cair.`);
  return mk("warn", "🟡", "Pode esperar", `Preço dentro do normal${left ? `; faltam ${left} dias` : ""}. O robô avisa se aparecer promoção.`);
}
const verdictChip = (v) => (v ? `<span class="badge ${v.cls}">${v.icon} ${esc(v.title)}</span>` : "");
const verdictCard = (v) => (v ? `<div class="verdict ${v.cls}"><div class="verdict-icon">${v.icon}</div><div><div class="muted tiny">Devo comprar agora?</div><b>${esc(v.title)}</b><div class="small">${esc(v.text)}</div></div></div>` : "");

// companhias aéreas mais comuns (códigos IATA)
const AIRLINES = { LA: "LATAM", JJ: "LATAM", G3: "GOL", AD: "Azul", JA: "JetSMART", WJ: "JetSMART", AR: "Aerolíneas Argentinas", FO: "Flybondi", H2: "SKY", CM: "Copa", AV: "Avianca", TP: "TAP", AF: "Air France", KL: "KLM", IB: "Iberia", UX: "Air Europa", AA: "American", UA: "United", DL: "Delta", LH: "Lufthansa", LX: "Swiss", BA: "British Airways", AZ: "ITA", EK: "Emirates", QR: "Qatar", TK: "Turkish", AC: "Air Canada", AM: "Aeroméxico", ET: "Ethiopian", ZP: "Paranair", "2Z": "Voepass", DM: "Arajet", "4M": "LATAM" };
const airlineName = (c) => AIRLINES[c] || c || "";

// ---------------------------------------------------------------------------
// Status do robô (no topo)
// ---------------------------------------------------------------------------
async function updateBotStatus() {
  if (!session) { $bot.hidden = true; return null; }
  try {
    const s = await q(sb.from("settings").select("*").eq("id", 1).maybeSingle());
    const hb = s?.bot_heartbeat_at;
    const mins = hb ? (Date.now() - new Date(hb)) / 60000 : Infinity;
    $bot.className = "bot-status " + (mins < 75 ? "ok" : mins < 240 ? "late" : "off");
    $bot.textContent = !hb ? "Robô ainda não rodou" : mins < 75 ? "Robô ativo" : mins < 240 ? "Robô atrasado" : "Robô parado";
    $bot.title = hb ? `Última execução: ${fmtDateTime(hb)}` : "";
    $bot.hidden = false;
    return s;
  } catch { $bot.hidden = true; return null; }
}

// ---------------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------------
const ROUTES = [
  [/^#\/login$/, viewLogin],
  [/^#\/?$/, viewHome],
  [/^#\/explorar$/, viewExplore],
  [/^#\/destino\/([A-Z0-9]{3})$/, viewDestination],
  [/^#\/hoteis\/([\w-]+)$/, viewHotels],
  [/^#\/nova$/, viewForm],
  [/^#\/editar\/([\w-]+)$/, viewForm],
  [/^#\/rota\/([\w-]+)$/, viewRoute],
  [/^#\/alertas$/, viewAlerts],
  [/^#\/config$/, viewSettings],
];

let hashParams = new URLSearchParams();

async function render() {
  const [hash, query = ""] = (location.hash || "#/").split("?");
  hashParams = new URLSearchParams(query);
  if (!session && hash !== "#/login") { location.replace("#/login"); return; }
  if (session && hash === "#/login") { location.replace("#/"); return; }
  $tabs.hidden = !session;
  const tab = hash.startsWith("#/alertas") ? "alertas" : hash.startsWith("#/config") ? "config" : hash.startsWith("#/explorar") || hash.startsWith("#/destino") || hash.startsWith("#/hoteis") ? "explorar" : "rotas";
  $tabs.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  const seq = ++renderSeq;
  const match = ROUTES.find(([re]) => re.test(hash));
  if (!match) { location.replace("#/"); return; }
  const args = hash.match(match[0]).slice(1);
  try {
    const html = await match[1](...args);
    if (seq !== renderSeq) return;
    if (typeof html === "string") $view.innerHTML = html;
    window.scrollTo(0, 0);
    match[1].after?.(...args);
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error(e);
    $view.innerHTML = `<div class="hint bad">Algo deu errado: ${esc(friendlyError(e))}</div>
      <p><button class="btn" onclick="location.reload()">Tentar de novo</button></p>`;
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function viewLogin() {
  return `<div class="login">
    <img class="logo" src="icons/icon.svg" alt="">
    <h1 class="center">Radar de Voos</h1>
    <p class="muted center">Acompanha os preços das suas passagens 24 horas e avisa quando ficam abaixo do normal.</p>
    <form class="card stack" id="login-form">
      <div class="seg" id="login-mode"><button type="button" class="on" data-m="in">Entrar</button><button type="button" data-m="up">Criar conta</button></div>
      <label class="field"><span>E-mail</span><input class="input" type="email" name="email" autocomplete="email" required></label>
      <label class="field"><span>Senha</span><input class="input" type="password" name="password" autocomplete="current-password" minlength="6" required></label>
      <button class="btn primary block" type="submit">Entrar</button>
      <div id="login-msg" class="small"></div>
    </form>
  </div>`;
}
viewLogin.after = () => {
  let mode = "in";
  const form = document.getElementById("login-form");
  const msg = document.getElementById("login-msg");
  document.getElementById("login-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.m;
    form.querySelectorAll("#login-mode button").forEach((x) => x.classList.toggle("on", x === b));
    form.querySelector("[type=submit]").textContent = mode === "in" ? "Entrar" : "Criar conta";
    form.password.autocomplete = mode === "in" ? "current-password" : "new-password";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true; msg.textContent = "";
    const email = form.email.value.trim(), password = form.password.value;
    try {
      if (mode === "in") {
        await q(sb.auth.signInWithPassword({ email, password }));
      } else {
        const data = await q(sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
        if (!data.session) { msg.innerHTML = `<div class="hint">Conta criada! Abra o e-mail de confirmação e depois entre aqui.</div>`; }
      }
    } catch (err) {
      msg.innerHTML = `<div class="hint bad">${esc(friendlyError(err))}</div>`;
    } finally { btn.disabled = false; }
  });
};

// ---------------------------------------------------------------------------
// Início: lista de rotas
// ---------------------------------------------------------------------------
async function viewHome() {
  const [routes, latest, totals, trend, deals] = await Promise.all([
    q(sb.from("routes").select("*").order("created_at")),
    q(sb.from("route_latest").select("route_id,depart_date,return_date,price,normal_price,checked_at").is("leg", null).gte("depart_date", todayIso()).limit(1000)),
    q(sb.from("route_latest").select("route_id,leg,depart_date,return_date,price,normal_price,checked_at").in("leg", ["rt", "combo"]).eq("direct_only", false).gte("checked_at", isoDaysAgo(2)).limit(1000)),
    q(sb.from("route_trend").select("route_id,checked_at,best_price").gte("checked_at", isoDaysAgo(10)).order("checked_at").limit(1000)),
    q(sb.from("deals").select("*").order("price").limit(200)).catch(() => []),
  ]);
  updateBotStatus();
  const dests = await loadDestinations([...routes.map((r) => r.destination), ...deals.slice(0, 40).map((d) => d.destination)]);
  const active = routes.filter((r) => r.active).length;
  const canAdd = active < MAX_ROUTES;
  const head = `<div class="row between"><h1>Suas rotas</h1><span class="muted small">${active} de ${MAX_ROUTES} ativas</span></div>`;
  if (!routes.length) {
    const ideas = deals.filter((d) => d.country_code !== "BR").slice(0, 3);
    return `${head}<div class="card empty"><div class="big">✈️</div>
      <p><b>Nenhuma rota ainda.</b><br>Cadastre a viagem que você quer acompanhar e o robô começa a vigiar os preços.</p>
      <a class="btn primary" href="#/nova">Cadastrar primeira rota</a></div>
      ${ideas.length ? `<h2>Ideias saindo de ${esc(originName(ideas[0].origin, routes))}</h2><div class="stack">${ideas.map((d) => dealCard(d, dests[d.destination], routes)).join("")}</div>
      <p><a class="btn block" href="#/explorar">Ver mais promoções</a></p>` : ""}`;
  }
  const cards = routes.map((r) => {
    const rows = r.date_mode === "long" ? lastCheck(totals.filter((x) => x.route_id === r.id && inScope(r, x))) : latest.filter((x) => x.route_id === r.id && inScope(r, x));
    const best = rows.reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null);
    const normal = best?.normal_price ?? (r.date_mode === "month" ? median(rows.map((x) => Number(x.price))) : null);
    const lv = best ? level(Number(best.price), normal ? Number(normal) : null, r.threshold_pct) : null;
    const points = trend.filter((t) => t.route_id === r.id).map((t) => ({ t: new Date(t.checked_at), y: Number(t.best_price) }));
    const spark = sparkline(points.map((p) => p.y));
    const change = dayChange(points);
    const low = points.length ? Math.min(...points.map((p) => p.y)) : null;
    const start = tripStart(r, best);
    const verdict = best && r.active ? buyVerdict(best.price, normal, low, start) : null;
    const when = best ? (best.return_date ? `${fmtDay(best.depart_date)} → ${fmtDay(best.return_date)}` : fmtDay(best.depart_date)) : "";
    const d = dests[r.destination];
    return `<a class="card route-card has-photo" href="#/rota/${r.id}">
      <div class="route-photo" ${bgPhoto(photo(d))}>
        <div class="route-photo-text">
          <div class="od ellipsis">${esc(place(r, "origin"))}<span class="arrow">→</span>${esc(place(r, "destination"))}</div>
          <div class="meta">${esc(tripLabel(r))}</div>
        </div>
        ${!r.active ? `<span class="badge paused photo-badge">pausada</span>` : countdown(start) ? `<span class="badge photo-badge">${countdown(start)}</span>` : ""}
      </div>
      <div class="route-body">
        <div class="row between wrap">
          <div>
            <div class="price-big">${best ? brl(best.price) : "…"} ${best && r.date_mode !== "fixed" ? `<small>em ${esc(when)}</small>` : ""}</div>
            <div class="muted small">${best ? `normal ~${brl(normal)} · ${ago(best.checked_at)}` : r.active ? "aguardando a primeira verificação" : ""}</div>
          </div>
          ${change ? `<span class="badge ${change.cls}">${esc(change.text)}</span>` : lv ? `<span class="badge ${lv.cls}">${esc(lv.label)}</span>` : ""}
        </div>
        ${best ? thermo(best.price, normal) : ""}
        ${verdict ? `<div style="margin-top:8px">${verdictChip(verdict)}</div>` : ""}
        ${spark}
        ${r.last_error ? `<div class="error-line">⚠️ ${esc(r.last_error)}</div>` : ""}
      </div>
    </a>`;
  }).join("");
  return `${head}<div class="stack">${cards}</div>
    <p>${canAdd ? `<a class="btn primary block" href="#/nova">+ Nova rota</a>` : `<span class="muted small">Limite de ${MAX_ROUTES} rotas ativas. Pause uma para cadastrar outra.</span>`}</p>`;
}

// ---------------------------------------------------------------------------
// Detalhe da rota
// ---------------------------------------------------------------------------
let current = null; // dados da rota aberta, usados pelos botões

async function viewRoute(id) {
  const [route, latestAll, trend, alerts] = await Promise.all([
    q(sb.from("routes").select("*").eq("id", id).maybeSingle()),
    q(sb.from("route_latest").select("*").eq("route_id", id).is("leg", null).gte("depart_date", todayIso()).limit(1000)),
    q(sb.from("route_trend").select("checked_at,best_price,normal_price").eq("route_id", id).gte("checked_at", isoDaysAgo(30)).order("checked_at").limit(1000)),
    q(sb.from("alerts").select("*").eq("route_id", id).order("created_at", { ascending: false }).limit(15)),
  ]);
  if (!route) return `<div class="hint warn">Rota não encontrada.</div><p><a class="btn" href="#/">Voltar</a></p>`;
  if (route.date_mode === "long") {
    const [legs, totals] = await Promise.all([
      q(sb.from("route_latest").select("*").eq("route_id", id).in("leg", ["out", "back"]).limit(1000)),
      q(sb.from("route_latest").select("*").eq("route_id", id).in("leg", ["rt", "combo"]).gte("checked_at", isoDaysAgo(2)).order("price").limit(500)),
    ]);
    current = { route, legs, totals, series: "all" };
  }
  const latest = latestAll.filter((x) => inScope(route, x));
  const best = latest.reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null);
  const monthMedian = median(latest.map((x) => Number(x.price)));
  const normalOf = (row) => (row?.normal_price != null ? Number(row.normal_price) : route.date_mode === "month" ? monthMedian : null);
  if (route.date_mode === "long") Object.assign(current, { latest, normalOf });
  else current = { route, latest, normalOf };

  const dest = (await loadDestinations([route.destination]))[route.destination];
  const points = trend.map((t) => ({ t: new Date(t.checked_at), y: Number(t.best_price) }));
  const low = points.length ? Math.min(...points.map((p) => p.y)) : null;
  let top = best, topNormal = normalOf(best);
  if (route.date_mode === "long") {
    const ld = longData();
    top = [ld.combo, ld.rt].filter(Boolean).sort((a, b) => Number(a.price) - Number(b.price))[0] || null;
    topNormal = top?.normal_price != null ? Number(top.normal_price) : null;
  }
  const start = tripStart(route, top);
  const verdict = top && route.active ? buyVerdict(top.price, topNormal, low, start) : null;
  const [from, to] = tripRange(route);
  const bestCard = route.date_mode === "long" ? "" : best ? priceCard(route, best, normalOf(best), "Menor preço agora") : `<div class="card"><div class="muted">${route.active ? "Ainda sem preços. O robô verifica em até ~15 min depois de cadastrar." : "Rota pausada."}</div></div>`;
  const nextCheck = route.last_checked_at ? new Date(new Date(route.last_checked_at).getTime() + route.check_every_hours * 3600000) : null;
  const requested = route.check_requested_at && (!route.last_checked_at || route.check_requested_at > route.last_checked_at);

  return `
    <p><a href="#/" class="small">← Rotas</a></p>
    <div class="hero" ${bgPhoto(photo(dest, 960))}>
      <div class="hero-text">
        <h1>${esc(place(route, "origin"))} → ${esc(place(route, "destination"))}</h1>
        <div class="small">${esc(tripLabel(route))}</div>
      </div>
      ${!route.active ? `<span class="badge paused photo-badge">pausada</span>` : countdown(start) ? `<span class="badge photo-badge">${countdown(start)}</span>` : ""}
    </div>
    <a class="card know-card" href="#/destino/${esc(route.destination)}?de=${from}&ate=${to}&adultos=${route.adults}">
      <span>🧭 Conhecer ${esc(dest?.name || place(route, "destination"))}: clima nas suas datas, pontos turísticos, moeda…</span><span>→</span>
    </a>
    <a class="card know-card" style="margin-top:8px" href="#/destino/${esc(route.destination)}?de=${from}&ate=${to}&adultos=${route.adults}&hoteis=1">
      <span>🏨 Comparar hotéis para essas datas</span><span>→</span>
    </a>
    ${verdict ? `<div style="margin-top:12px">${verdictCard(verdict)}</div>` : ""}
    ${route.last_error ? `<div class="hint warn" style="margin-top:12px">⚠️ ${esc(route.last_error)}</div>` : ""}
    <div style="margin-top:16px">${bestCard}</div>

    ${route.date_mode === "month" ? `<h2>Calendário de ${esc(fmtMonth(route.month))}</h2><div class="card">${calendar(route, latest, normalOf, best)}<div id="day-detail"></div></div>` : ""}
    ${route.date_mode === "long" ? `${route.track_direct ? `<div class="seg" id="series-seg" style="margin-top:16px"><button type="button" class="on" data-v="all">Todos os voos</button><button type="button" data-v="direct">Só diretos</button></div>` : ""}
      <div id="long-body">${longBody()}</div>` : ""}

    <h2>Histórico (30 dias)</h2>
    <div class="card">${lineChart(trend.map((t) => ({ t: new Date(t.checked_at), y: Number(t.best_price), n: t.normal_price != null ? Number(t.normal_price) : null })))}</div>

    <h2>Alertas desta rota</h2>
    <div class="card">${alerts.length ? `<div class="list">${alerts.map(alertItem).join("")}</div>` : `<div class="muted small">Nenhum alerta ainda. Você é avisado quando o preço cair ${route.threshold_pct}% abaixo do normal${route.target_price ? ` ou ficar abaixo de ${brl(route.target_price)}` : ""}.</div>`}</div>

    <h2>Verificações</h2>
    <div class="card">
      <dl class="kv">
        <dt>Última</dt><dd>${route.last_checked_at ? `${fmtDateTime(route.last_checked_at)} (${ago(route.last_checked_at)})` : "ainda não"}</dd>
        <dt>Intervalo</dt><dd>a cada ${route.check_every_hours} h</dd>
        <dt>Próxima</dt><dd>${!route.active ? "pausada" : requested ? "pedida, em até ~15 min" : nextCheck ? `~${fmtDateTime(nextCheck)}` : "em até ~15 min"}</dd>
        <dt>Alertar quando</dt><dd>${route.threshold_pct}% abaixo do normal${route.target_price ? ` ou &lt; ${brl(route.target_price)}` : ""}</dd>
      </dl>
    </div>

    <div class="fab-row" style="margin-top:16px">
      <button class="btn primary" id="act-check" ${route.active ? "" : "disabled"}>↻ Verificar agora</button>
      <a class="btn" href="#/editar/${route.id}">Editar</a>
      <button class="btn" id="act-toggle">${route.active ? "Pausar" : "Reativar"}</button>
    </div>
    <p><button class="btn danger block" id="act-delete">Apagar rota</button></p>`;
}
viewRoute.after = (id) => {
  const { route } = current;
  document.getElementById("act-check")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await q(sb.from("routes").update({ check_requested_at: new Date().toISOString() }).eq("id", id));
      toast("Pedido enviado! O robô verifica em até ~15 min.");
    } catch (err) { toast(friendlyError(err)); e.target.disabled = false; }
  });
  document.getElementById("act-toggle").addEventListener("click", async () => {
    try {
      await q(sb.from("routes").update({ active: !route.active, check_requested_at: new Date().toISOString(), last_error: null }).eq("id", id));
      toast(route.active ? "Rota pausada." : "Rota reativada.");
      render();
    } catch (err) { toast(friendlyError(err), 5000); }
  });
  const del = document.getElementById("act-delete");
  del.addEventListener("click", async () => {
    if (!del.dataset.confirm) { del.dataset.confirm = "1"; del.textContent = "Toque de novo para apagar (some o histórico)"; return; }
    try {
      await q(sb.from("routes").delete().eq("id", id));
      toast("Rota apagada.");
      location.hash = "#/";
    } catch (err) { toast(friendlyError(err)); }
  });
  document.getElementById("series-seg")?.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    current.series = b.dataset.v;
    document.querySelectorAll("#series-seg button").forEach((x) => x.classList.toggle("on", x === b));
    document.getElementById("long-body").innerHTML = longBody();
    bindCalendars();
  });
  bindCalendars();
};

function bindCalendars() {
  document.querySelectorAll(".cal").forEach((cal) => cal.addEventListener("click", (e) => {
    const cell = e.target.closest(".day[data-d]"); if (!cell) return;
    const group = cal.dataset.g || "";
    document.querySelectorAll(`.cal[data-g="${group}"] .day.sel`).forEach((x) => x.classList.remove("sel"));
    cell.classList.add("sel");
    const detail = document.getElementById(group ? `detail-${group}` : "day-detail");
    detail.innerHTML = group ? longDayDetail(group, cell.dataset.d) : (() => {
      const row = current.latest.find((x) => x.depart_date === cell.dataset.d);
      return row ? `<div style="margin-top:12px">${priceCard(current.route, row, current.normalOf(row), "Dia selecionado")}</div>` : "";
    })();
  }));
}

// ---------------------------------------------------------------------------
// Viagem longa: melhor total + calendários de ida e de volta
// ---------------------------------------------------------------------------
const LEG_LABEL = { out: "Só ida", back: "Só volta", rt: "Ida e volta", combo: "Duas passagens só de ida" };

// linhas da última verificação (o melhor total de uma rodada antiga já não vale)
function lastCheck(rows) {
  const at = rows.reduce((a, b) => (b.checked_at > a ? b.checked_at : a), "");
  return rows.filter((x) => x.checked_at === at);
}

function longData() {
  const { route, legs, totals, series } = current;
  const mine = (rows) => rows.filter((x) => !!x.direct_only === (series === "direct") && inScopeLong(route, x));
  const leg = (name) => {
    const rows = mine(legs.filter((x) => x.leg === name));
    const med = median(rows.map((x) => Number(x.price)));
    return { rows, byDay: Object.fromEntries(rows.map((x) => [x.depart_date, x])), normalOf: (row) => (row?.normal_price != null ? Number(row.normal_price) : med) };
  };
  const recent = lastCheck(mine(totals));
  const cheapest = (rows) => rows.reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null);
  return { out: leg("out"), back: leg("back"), combo: recent.find((x) => x.leg === "combo") || null, rt: cheapest(recent.filter((x) => x.leg === "rt")) };
}

function longBody() {
  const { route } = current;
  const d = longData();
  const w = longWindows(route);
  const o = esc(place(route, "origin")), dest = esc(place(route, "destination"));
  const best = (leg) => leg.rows.reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null)?.depart_date;
  return `
    ${route.trip_type === "round_trip" ? `<div style="margin-top:16px">${totalsCard(route, d.combo, d.rt)}</div>` : ""}
    <h2>Ida · ${o} → ${dest} <span class="muted small">(só ida)</span></h2>
    <div class="card">${w.outFrom <= w.outTo ? calendarRange(w.outFrom, w.outTo, d.out.byDay, d.out.normalOf, best(d.out), "out") : `<div class="muted small">As datas de ida já passaram.</div>`}<div id="detail-out"></div></div>
    ${w.backFrom ? `<h2>Volta · ${dest} → ${o} <span class="muted small">(só volta)</span></h2>
    <div class="card">${calendarRange(w.backFrom, w.backTo, d.back.byDay, d.back.normalOf, best(d.back), "back")}<div id="detail-back"></div></div>` : ""}`;
}

function totalsCard(route, combo, rt) {
  const options = [combo, rt].filter(Boolean).sort((a, b) => Number(a.price) - Number(b.price));
  if (!options.length) {
    return `<div class="card"><div class="muted small">Melhor total da viagem</div><div class="muted" style="margin-top:6px">${route.active ? "Ainda montando: o robô precisa de preços de ida e de volta. Leva algumas rodadas (~15 min cada)." : "Rota pausada."}</div></div>`;
  }
  const top = options[0];
  const lv = level(Number(top.price), top.normal_price != null ? Number(top.normal_price) : null, route.threshold_pct);
  const line = (row) => {
    const stay = daysBetween(row.depart_date, row.return_date);
    const links = row.leg === "combo"
      ? `<a class="btn sm" href="${esc(googleUrl(route, row.depart_date, null))}" target="_blank" rel="noopener">Ida no Google ↗</a>
         <a class="btn sm" href="${esc(googleUrl(route, row.return_date, null, true))}" target="_blank" rel="noopener">Volta no Google ↗</a>
         <a class="btn sm" href="${esc(googleUrl(route, row.depart_date, row.return_date))}" target="_blank" rel="noopener">Comparar com ida e volta ↗</a>`
      : `<a class="btn sm" href="${esc(row.source === "google" && row.link ? row.link : googleUrl(route, row.depart_date, row.return_date))}" target="_blank" rel="noopener">Ver no Google Flights ↗</a>
         ${row.source === "aviasales" && row.link ? `<a class="btn sm" href="${esc(row.link)}" target="_blank" rel="noopener">Aviasales ↗</a>` : ""}`;
    return `<div class="item"><div class="grow">
      <div class="row between"><b>${esc(LEG_LABEL[row.leg])}</b><b>${brl(row.price)}</b></div>
      <div class="small">📅 ${esc(fmtDay(row.depart_date))} → ${esc(fmtDay(row.return_date))} · ${stay} dias</div>
      <div class="muted small">${esc([row.airline, stopsLabel(row.stops)].filter(Boolean).join(" · "))}</div>
      <div class="fab-row" style="margin-top:8px">${links}</div>
    </div></div>`;
  };
  return `<div class="card">
    <div class="muted small">Melhor total da viagem agora</div>
    <div class="row between wrap" style="margin-top:4px">
      <div class="price-big">${brl(top.price)}</div>
      <span class="badge ${lv.cls}">${esc(lv.label)}</span>
    </div>
    ${thermo(top.price, top.normal_price)}
    <div class="list" style="margin-top:10px">${options.map(line).join("")}</div>
    <div class="muted tiny" style="margin-top:8px">Duas passagens só de ida podem ser de companhias diferentes. A passagem de ida e volta só é consultada pelo robô em viagens de até 30 dias; acima disso, toque em “Comparar com ida e volta”. ${ago(top.checked_at)}.</div>
  </div>`;
}

// Ao tocar num dia: o preço do trecho e o melhor par para ele (volta para uma ida, ou ida para uma volta)
function longDayDetail(group, iso) {
  const { route } = current;
  const d = longData();
  const leg = d[group];
  const row = leg.byDay[iso];
  if (!row) return "";
  let pair = "";
  if (route.trip_type === "round_trip") {
    const other = group === "out" ? d.back : d.out;
    const fits = other.rows.filter((x) => (group === "out" ? stayOk(route, iso, x.depart_date) : stayOk(route, x.depart_date, iso)));
    const best = fits.reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null);
    if (best) {
      const [dep, ret] = group === "out" ? [iso, best.depart_date] : [best.depart_date, iso];
      pair = `<div class="hint" style="margin-top:8px">Melhor ${group === "out" ? "volta para esta ida" : "ida para esta volta"}: <b>${brl(best.price)}</b> em ${esc(fmtDay(best.depart_date))}.<br>
        Total com duas passagens só de ida: <b>${brl(Number(row.price) + Number(best.price))}</b> · ${daysBetween(dep, ret)} dias de viagem.</div>`;
    }
  }
  return `<div style="margin-top:12px">${priceCard(route, row, leg.normalOf(row), group === "out" ? "Ida selecionada (só ida)" : "Volta selecionada (só volta)")}${pair}</div>`;
}

function priceCard(route, row, normal, title) {
  const lv = level(Number(row.price), normal, route.threshold_pct);
  const dates = row.return_date ? `${fmtDay(row.depart_date)} → ${fmtDay(row.return_date)}` : fmtDay(row.depart_date);
  const details = [row.airline, stopsLabel(row.stops), sourceLabel(row.source)].filter(Boolean).join(" · ");
  const gLink = row.source === "google" && row.link ? row.link : googleUrl(route, row.depart_date, row.return_date, row.leg === "back");
  const aLink = row.source === "aviasales" && row.link ? row.link : null;
  return `<div class="card">
    <div class="muted small">${esc(title)}</div>
    <div class="row between wrap" style="margin-top:4px">
      <div class="price-big">${brl(row.price)}</div>
      <span class="badge ${lv.cls}">${esc(lv.label)}</span>
    </div>
    ${thermo(row.price, normal)}
    <div style="margin-top:6px;font-weight:600">📅 ${esc(dates)}</div>
    <div class="muted small">${esc(details)}${normal ? ` · normal ~${brl(normal)}` : ""} · ${ago(row.checked_at)}</div>
    <div class="fab-row" style="margin-top:12px">
      <a class="btn sm" href="${esc(gLink)}" target="_blank" rel="noopener">Ver no Google Flights ↗</a>
      ${aLink ? `<a class="btn sm" href="${esc(aLink)}" target="_blank" rel="noopener">Ver na Aviasales ↗</a>` : ""}
    </div>
  </div>`;
}

function calendar(route, latest, normalOf, best) {
  const first = parseDate(route.month);
  const last = isoOf(new Date(first.getFullYear(), first.getMonth() + 1, 0));
  return calendarRange(route.month, last, Object.fromEntries(latest.map((x) => [x.depart_date, x])), normalOf, best?.depart_date);
}

// Calendário de um intervalo de datas, um bloco por mês. group separa os calendários da mesma tela.
function calendarRange(fromIso, toIso, byDay, normalOf, bestIso, group = "") {
  const today = todayIso();
  const end = parseDate(toIso);
  const multi = fromIso.slice(0, 7) !== toIso.slice(0, 7);
  let out = "";
  for (let cur = parseDate(fromIso.slice(0, 8) + "01"); cur <= end; cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)) {
    const y = cur.getFullYear(), m = cur.getMonth();
    let html = WD.map((w) => `<div class="wd">${w}</div>`).join("") + `<div></div>`.repeat(cur.getDay());
    for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++) {
      const iso = isoOf(new Date(y, m, d));
      const row = byDay[iso];
      if (iso <= today || iso < fromIso || iso > toIso) { html += `<div class="day past"><span class="n">${d}</span></div>`; continue; }
      if (!row) { html += `<div class="day none"><span class="n">${d}</span><span class="p">–</span></div>`; continue; }
      const p = pct(Number(row.price), normalOf(row));
      const cls = p == null ? "lvl-mid" : p >= 5 ? "lvl-good" : p > -8 ? "lvl-mid" : p > -20 ? "lvl-warn" : "lvl-bad";
      html += `<button type="button" class="day ${cls} ${bestIso === iso ? "best" : ""}" data-d="${iso}"><span class="n">${d}</span><span class="p">${compactBrl(row.price)}</span></button>`;
    }
    out += `${multi ? `<div class="cal-month">${MONTHS[m]} de ${y}</div>` : ""}<div class="cal" data-g="${group}">${html}</div>`;
  }
  return `${out}
    <div class="legend" style="margin-top:10px"><span>Toque num dia para ver detalhes.</span><span>Verde = abaixo do normal · laranja/vermelho = acima.</span></div>`;
}

function alertItem(a, withRoute = false) {
  const dates = a.return_date ? `${fmtDay(a.depart_date)} → ${fmtDay(a.return_date)}` : fmtDay(a.depart_date);
  const r = a.routes;
  const title = withRoute && r ? `${esc(place(r, "origin"))} → ${esc(place(r, "destination"))} · ` : "";
  return `<div class="item">
    <div style="font-size:22px">🔥</div>
    <div class="grow">
      <div class="row between"><b>${title}${brl(a.price)}</b><span class="muted tiny">${ago(a.created_at)}</span></div>
      <div class="small">${a.leg ? `${esc(LEG_LABEL[a.leg])}${a.direct_only ? " (direto)" : ""} · ` : ""}${esc(dates)}${a.normal_price ? ` · normal ~${brl(a.normal_price)}` : ""}</div>
      <div class="muted small">${esc((a.reasons || []).join("; "))}</div>
      <div class="row wrap tiny muted" style="gap:8px;margin-top:4px">
        ${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">abrir oferta ↗</a>` : ""}
        <span>${a.channels?.length ? "enviado por " + esc(a.channels.join(", ")) : "não enviado (sem canal configurado)"}</span>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Explorar: promoções saindo das suas origens (o robô atualiza a cada 6 h)
// ---------------------------------------------------------------------------
const CITY_NAMES = { RIO: "Rio de Janeiro", SAO: "São Paulo", BHZ: "Belo Horizonte", BSB: "Brasília" };
function originName(code, routes = []) {
  return routes.find((r) => r.origin === code)?.origin_label || CITY_NAMES[code] || code;
}

function dealCard(d, dest, routes = []) {
  const days = d.return_date ? daysBetween(d.depart_date, d.return_date) : null;
  const dates = d.return_date ? `${fmtShort(d.depart_date)} → ${fmtShort(d.return_date)} · ${days} dias` : fmtShort(d.depart_date);
  const track = new URLSearchParams({ orig: d.origin, orignome: originName(d.origin, routes), dest: d.destination, nome: d.destination_label || d.destination, mes: d.depart_date.slice(0, 7), ...(days ? { dias: String(days) } : {}) });
  return `<div class="card deal">
    <a class="deal-photo" href="#/destino/${esc(d.destination)}" ${bgPhoto(photo(dest))}>${dest?.thumb ? "" : "✈️"}</a>
    <div class="deal-body">
      <div class="row between" style="align-items:flex-start;gap:8px">
        <div class="grow"><b>${esc(d.destination_label || d.destination)}</b><div class="muted tiny">${esc(d.country_name || "")}</div></div>
        <div style="text-align:right"><b class="deal-price">${brl(d.price)}</b><div class="muted tiny">ida e volta</div></div>
      </div>
      <div class="small" style="margin-top:4px">📅 ${esc(dates)}</div>
      <div class="muted tiny">${esc([airlineName(d.airline), stopsLabel(d.stops)].filter(Boolean).join(" · "))}</div>
      <div class="fab-row" style="margin-top:8px">
        <a class="btn sm primary" href="#/nova?${track}">Acompanhar</a>
        <a class="btn sm" href="#/destino/${esc(d.destination)}">Conhecer</a>
        ${d.link ? `<a class="btn sm" href="${esc(d.link)}" target="_blank" rel="noopener">Oferta ↗</a>` : ""}
      </div>
    </div>
  </div>`;
}

let explore = { scope: "intl", origin: null };

async function viewExplore() {
  const [deals, routes, settings] = await Promise.all([
    q(sb.from("deals").select("*").order("price").limit(300)),
    q(sb.from("routes").select("origin,origin_label")),
    q(sb.from("settings").select("deals_refreshed_at").eq("id", 1).maybeSingle()),
  ]);
  if (!deals.length) {
    return `<h1>Explorar</h1><div class="card empty"><div class="big">🧭</div><p>O robô ainda está buscando as promoções.<br>Volte em ~15 minutos.</p></div>`;
  }
  const origins = [...new Set(deals.map((d) => d.origin))];
  if (!origins.includes(explore.origin)) explore.origin = origins.includes("RIO") ? "RIO" : origins[0];
  const dests = await loadDestinations(deals.map((d) => d.destination));
  explore = { ...explore, deals, routes, dests };
  return `<h1>Explorar</h1>
    <p class="muted small" style="margin-top:-6px">Passagens de ida e volta mais baratas encontradas nos últimos dias, por pessoa. Atualizado ${ago(settings?.deals_refreshed_at)}.</p>
    ${origins.length > 1 ? `<label class="field"><span>Saindo de</span><select class="input" id="exp-origin">${origins.map((o) => `<option value="${esc(o)}" ${o === explore.origin ? "selected" : ""}>${esc(originName(o, routes))}</option>`).join("")}</select></label><div style="height:10px"></div>` : ""}
    <div class="seg" id="exp-scope"><button type="button" data-v="intl">🌎 Internacional</button><button type="button" data-v="br">🇧🇷 Nacional</button></div>
    <div id="exp-list" class="stack" style="margin-top:14px"></div>`;
}
viewExplore.after = () => {
  const draw = () => {
    const { deals, dests, routes, scope, origin } = explore;
    if (!deals) return;
    document.querySelectorAll("#exp-scope button").forEach((b) => b.classList.toggle("on", b.dataset.v === scope));
    const list = deals.filter((d) => d.origin === origin && (scope === "br" ? d.country_code === "BR" : d.country_code !== "BR"));
    document.getElementById("exp-list").innerHTML = list.length ? list.map((d) => dealCard(d, dests[d.destination], routes)).join("") : `<div class="card empty">Nenhuma promoção nesta categoria agora.</div>`;
  };
  document.getElementById("exp-scope")?.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    explore.scope = b.dataset.v; draw();
  });
  document.getElementById("exp-origin")?.addEventListener("change", (e) => { explore.origin = e.target.value; draw(); });
  draw();
};

// ---------------------------------------------------------------------------
// Destino: foto, informações práticas, clima nas suas datas, pontos turísticos
// (o robô prepara o que é lento; clima, câmbio e fuso vêm ao vivo)
// ---------------------------------------------------------------------------
const SCHENGEN = "AT BE BG HR CZ DK EE FI FR DE GR HU IS IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE CH".split(" ");
const RG_COUNTRIES = "AR UY PY CL BO PE CO EC VE".split(" ");
function entryRules(cc) {
  if (cc === "BR") return "Viagem nacional: leve um documento oficial com foto.";
  if (SCHENGEN.includes(cc)) return "Brasileiro não precisa de visto para turismo: até 90 dias a cada 180 na área Schengen. Leve passaporte válido, seguro-viagem e comprovantes de hospedagem e volta. Confira se a autorização ETIAS já está sendo exigida.";
  if (RG_COUNTRIES.includes(cc)) return "Dá para entrar só com o RG (carteira de identidade) em bom estado, de preferência emitido há menos de 10 anos, ou com passaporte.";
  if (cc === "US") return "Exige visto americano (turismo B1/B2) e passaporte válido.";
  if (cc === "GB") return "Não precisa de visto para turismo, mas exige a autorização eletrônica ETA antes do embarque.";
  if (cc === "CA") return "Exige visto ou autorização eletrônica eTA (para quem tem ou teve visto americano nos últimos 10 anos).";
  return null;
}

// tomadas: nome técnico (Wikidata) → tipo por letra; no Brasil usamos N e C
const PLUG_TYPES = { "Europlug": "C", "Schuko": "F", "CEE 7/5": "E", "AS/NZS 3112": "I", "IEC 60906-1": "N", "NEMA 1-15": "A", "NEMA 5-15": "B", "BS 1363": "G", "BS 546": "D", "CEI 23-50": "L", "SEV 1011": "J", "SI 32": "H" };
function plugInfo(f) {
  const types = [...new Set((f?.plugs || []).map((p) => PLUG_TYPES[p] || (p.match(/\b(?:Type|tipo)\s+([A-N])\b/i) || [])[1]).filter(Boolean))].sort();
  if (!types.length) return null;
  const ok = types.some((t) => t === "C" || t === "N");
  return `Tipo ${types.join(", ")}${f.voltage ? ` · ${f.voltage} V` : ""}${ok ? "" : " · leve adaptador"}`;
}

async function viewDestination(code) {
  let d = await q(sb.from("destinations").select("*").eq("code", code).maybeSingle());
  const needAttractions = !d?.attractions_at && (!d?.attractions_requested_at || Date.now() - new Date(d.attractions_requested_at) > 3600000);
  if (needAttractions) {
    // pede para o robô preparar (na próxima rodada, ~15 min)
    const now = new Date().toISOString();
    try { await q(sb.from("destinations").upsert({ code, attractions_requested_at: now }, { onConflict: "code" })); } catch {}
  }
  if (!d?.lat) {
    return `<p><a href="javascript:history.back()" class="small">← Voltar</a></p>
      <div class="card empty"><div class="big">🧭</div><p><b>Preparando este destino…</b><br>O robô junta fotos, pontos turísticos e informações práticas. Volte em ~15 minutos.</p></div>`;
  }
  const de = hashParams.get("de"), ate = hashParams.get("ate");
  current = { dest: d, de, ate };
  const f = d.facts || {};
  const plugs = plugInfo(f);
  const rules = entryRules(d.country_code);
  const attractions = d.attractions || [];
  return `
    <p><a href="javascript:history.back()" class="small">← Voltar</a></p>
    <div class="hero tall" ${bgPhoto(photo(d, 960))}>
      <div class="hero-text"><h1>${esc(d.name)}</h1><div class="small">${esc(d.country_name || "")}</div></div>
    </div>

    <div class="facts">
      <div class="fact"><div class="fact-k">💱 Moeda</div><div class="fact-v" id="fx">${f.currency && f.currency !== "BRL" ? esc(f.currency) + "…" : f.currency === "BRL" ? "Real (R$)" : "–"}</div></div>
      <div class="fact"><div class="fact-k">🕐 Fuso e tempo agora</div><div class="fact-v" id="tz">…</div></div>
      <div class="fact"><div class="fact-k">🗣️ Idioma</div><div class="fact-v">${esc((f.languages || []).join(", ") || "–")}</div></div>
      <div class="fact"><div class="fact-k">🔌 Tomada</div><div class="fact-v">${esc(plugs || "–")}</div></div>
    </div>

    <h2>🌦️ Clima ${de ? "nas suas datas" : "no próximo mês"}</h2>
    <div class="card" id="weather"><div class="muted small">Carregando…</div></div>

    ${rules ? `<h2>🛂 Entrada no país</h2><div class="card small">${esc(rules)}<div class="muted tiny" style="margin-top:6px">Regras mudam: confirme no consulado ou no <a href="https://www.gov.br/mre/pt-br/assuntos/portal-consular" target="_blank" rel="noopener">Portal Consular ↗</a> antes de viajar.</div></div>` : ""}

    ${d.summary ? `<h2>📖 Sobre</h2><div class="card small">${esc(d.summary)}${d.wiki_url ? `<div style="margin-top:8px"><a href="${esc(d.wiki_url)}" target="_blank" rel="noopener">Ler mais na Wikipedia ↗</a></div>` : ""}</div>` : ""}

    <h2>📍 Pontos turísticos</h2>
    ${attractions.length ? `<div class="spots">${attractions.map((a, i) => `<div class="spot">
        <div class="spot-photo" ${bgPhoto(a.image)}><span class="spot-rank">${i + 1}</span></div>
        <div class="spot-body">
          <b>${esc(a.name)}</b>
          ${a.desc ? `<div class="muted tiny">${esc(a.desc)}</div>` : ""}
          <div class="row tiny" style="gap:10px;margin-top:6px">
            <a href="${esc(a.link)}" target="_blank" rel="noopener">Saiba mais ↗</a>
            <a href="https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lon}" target="_blank" rel="noopener">Mapa ↗</a>
          </div>
        </div>
      </div>`).join("")}</div>
      <p class="muted tiny">Ordenados pela fama (em quantas Wikipedias aparecem). Fotos: Wikimedia Commons.</p>`
      : `<div class="card muted small">${d.attractions_at ? "Não encontramos pontos turísticos cadastrados aqui." : "Preparando a lista… o robô junta os pontos turísticos na próxima rodada (~15 min)."}</div>`}

    <h2 id="hoteis">🏨 Hotéis e hostels</h2>
    ${hotelForm(d)}`;
}

function hotelForm(d) {
  const de = hashParams.get("de"), ate = hashParams.get("ate");
  const tomorrow = addDays(todayIso(), 1);
  const ci = de && de > todayIso() ? de : addDays(todayIso(), 30);
  const co = ate && ate > ci && daysBetween(ci, ate) <= 30 ? ate : addDays(ci, 7);
  const adults = Math.max(1, Math.min(8, Number(hashParams.get("adultos")) || 2));
  return `<form class="card" id="hotel-form">
    <div class="grid2">
      <label class="field"><span>Check-in</span><input class="input" type="date" name="checkin" min="${tomorrow}" value="${ci}" required></label>
      <label class="field"><span>Check-out</span><input class="input" type="date" name="checkout" min="${tomorrow}" value="${co}" required></label>
    </div>
    <div class="grid2">
      <label class="field"><span>Hóspedes</span><select class="input" name="adults">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${n === adults ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="field"><span>Tipo</span><select class="input" name="kind"><option value="hotel">Hotéis</option><option value="hostel">Hostels</option></select></label>
    </div>
    <div id="hotel-msg"></div>
    <button class="btn primary block" type="submit" style="margin-top:12px">Comparar preços nos sites</button>
    <p class="muted tiny" style="margin:8px 0 0">Busca no Google Hotels e mostra o preço de cada hotel no Booking, Expedia, Hoteis.com, Decolar, Agoda e outros. Leva cerca de 1 minuto.</p>
  </form>`;
}

function bindHotelForm(d) {
  const f = document.getElementById("hotel-form");
  if (!f) return;
  if (hashParams.get("hoteis")) document.getElementById("hoteis")?.scrollIntoView?.({ block: "start" });
  const [ciIn, coIn, adIn, kindIn] = ["checkin", "checkout", "adults", "kind"].map((n) => f.elements.namedItem(n));
  ciIn.addEventListener("change", () => { if (coIn.value <= ciIn.value) coIn.value = addDays(ciIn.value, 7); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("hotel-msg");
    const row = { city_code: d.code, city_name: d.name, checkin: ciIn.value, checkout: coIn.value, adults: Number(adIn.value), kind: kindIn.value };
    const nights = daysBetween(row.checkin, row.checkout);
    if (!row.checkin || row.checkin <= todayIso()) { msg.innerHTML = `<div class="hint bad">O check-in precisa ser a partir de amanhã.</div>`; return; }
    if (nights < 1 || nights > 30) { msg.innerHTML = `<div class="hint bad">A estadia precisa ter de 1 a 30 noites.</div>`; return; }
    const btn = f.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      // mesma busca nas últimas 6 h: reaproveita
      const cached = await q(sb.from("hotel_searches").select("id").eq("city_name", row.city_name).eq("checkin", row.checkin).eq("checkout", row.checkout)
        .eq("adults", row.adults).eq("kind", row.kind).eq("status", "done").gte("created_at", new Date(Date.now() - 6 * 3600000).toISOString()).order("created_at", { ascending: false }).limit(1));
      const id = cached[0]?.id || (await q(sb.from("hotel_searches").insert(row).select("id").single())).id;
      location.hash = `#/hoteis/${id}`;
    } catch (err) { msg.innerHTML = `<div class="hint bad">${esc(friendlyError(err))}</div>`; btn.disabled = false; }
  });
}

// ---------------------------------------------------------------------------
// Resultado da busca de hotéis (o robô preenche hotel a hotel; a tela atualiza sozinha)
// ---------------------------------------------------------------------------
let hotelSort = "rec";

async function viewHotels(id) {
  const row = await q(sb.from("hotel_searches").select("*").eq("id", id).maybeSingle());
  if (!row) return `<div class="hint warn">Busca não encontrada.</div><p><a class="btn" href="#/explorar">Voltar</a></p>`;
  current = { hotelSearch: row };
  const nights = daysBetween(row.checkin, row.checkout);
  return `<p><a href="javascript:history.back()" class="small">← Voltar</a></p>
    <h1 style="margin-bottom:2px">${row.kind === "hostel" ? "Hostels" : "Hotéis"} em ${esc(row.city_name)}</h1>
    <div class="muted small">${esc(fmtDay(row.checkin))} → ${esc(fmtDay(row.checkout))} · ${nights} noite${nights > 1 ? "s" : ""} · ${row.adults} hóspede${row.adults > 1 ? "s" : ""}</div>
    <div class="seg" id="hotel-sort" style="margin-top:14px"><button type="button" data-v="rec">Recomendados</button><button type="button" data-v="price">Menor preço</button><button type="button" data-v="rating">Melhor nota</button></div>
    <div id="hotels-body" style="margin-top:14px">${hotelsBody(row)}</div>`;
}
viewHotels.after = (id) => {
  const myHash = location.hash;
  const sortSeg = document.getElementById("hotel-sort");
  if (!sortSeg) return;
  const paint = () => {
    sortSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === hotelSort));
    document.getElementById("hotels-body").innerHTML = hotelsBody(current.hotelSearch);
  };
  sortSeg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; hotelSort = b.dataset.v; paint(); });
  paint();
  const started = Date.now();
  const timer = setInterval(async () => {
    if (location.hash !== myHash) return clearInterval(timer);
    try {
      const row = await q(sb.from("hotel_searches").select("*").eq("id", id).maybeSingle());
      if (location.hash !== myHash) return clearInterval(timer);
      current.hotelSearch = row;
      paint();
      if (["done", "error"].includes(row.status) || Date.now() - started > 6 * 60000) clearInterval(timer);
    } catch {}
  }, 4000);
};

function hotelsBody(row) {
  const hotels = [...(row.results || [])];
  const waiting = !["done", "error"].includes(row.status);
  if (row.status === "error") return `<div class="hint bad">A busca falhou: ${esc(row.error || "erro desconhecido")}. Tente de novo em alguns minutos.</div>`;
  if (!hotels.length) {
    return waiting
      ? `<div class="card empty"><div class="big">🔎</div><p><b>Procurando hotéis e comparando os sites…</b><br>Leva cerca de 1 minuto. Pode deixar esta tela aberta.</p></div>`
      : `<div class="card empty">Nenhum hotel encontrado para essas datas.</div>`;
  }
  const best = (h) => Math.min(...(h.offers || []).map((o) => o.total ?? Infinity), h.total ?? Infinity);
  if (hotelSort === "price") hotels.sort((a, b) => best(a) - best(b));
  if (hotelSort === "rating") hotels.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const pending = hotels.filter((h) => h.offers == null).length;
  return `${waiting ? `<div class="hint" style="margin-bottom:12px">🔎 Comparando os sites… ${hotels.length - pending} de ${hotels.length} hotéis prontos.</div>` : ""}
    <div class="stack">${hotels.map(hotelCard).join("")}</div>
    <p class="muted tiny">Preços do Google Hotels em reais, com taxas quando o site informa. Confira o valor final no site antes de reservar.</p>`;
}

function hotelCard(h) {
  const offers = h.offers || [];
  const row = (o, i) => `<div class="offer ${i === 0 ? "best" : ""}">
      <div class="grow"><b>${esc(o.provider)}</b>${i === 0 && offers.length > 1 ? ` <span class="badge good">mais barato</span>` : ""}
        <div class="muted tiny">${o.night != null ? `${brl(o.night)}/noite` : ""}</div></div>
      <b>${o.total != null ? brl(o.total) : brl(o.night)}</b>
      ${o.link ? `<a class="btn sm" href="${esc(o.link)}" target="_blank" rel="noopener">Reservar ↗</a>` : ""}
    </div>`;
  const stars = h.stars ? "★".repeat(h.stars) : "";
  return `<div class="card hotel">
    <div class="hotel-photo" ${bgPhoto(h.image)}>${stars ? `<span class="badge photo-badge">${stars}</span>` : ""}</div>
    <div class="hotel-body">
      <b class="hotel-name">${esc(h.name)}</b>
      <div class="small">${h.rating ? `⭐ ${Number(h.rating).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}/5` : ""}${h.reviews ? ` · ${Number(h.reviews).toLocaleString("pt-BR")} avaliações` : ""}</div>
      <div class="muted small" style="margin-top:2px">a partir de <b>${brl(h.night)}/noite</b>${h.total ? ` · ${brl(h.total)} no total` : ""}</div>
      <div class="offers">
        ${h.offers == null ? `<div class="muted small">⏳ comparando os sites…</div>`
          : !offers.length ? `<div class="muted small">Sem preços por site para essas datas.</div>`
          : offers.slice(0, 4).map(row).join("") + (offers.length > 4 ? `<details><summary class="small">ver mais ${offers.length - 4} site${offers.length - 4 > 1 ? "s" : ""}</summary>${offers.slice(4).map((o, i) => row(o, i + 4)).join("")}</details>` : "")}
      </div>
      <div class="row tiny" style="gap:12px;margin-top:8px">
        ${h.page ? `<a href="${esc(h.page)}" target="_blank" rel="noopener">Ver no Google Hotels ↗</a>` : ""}
        ${h.lat ? `<a href="https://www.google.com/maps/search/?api=1&query=${h.lat},${h.lng}" target="_blank" rel="noopener">Mapa ↗</a>` : ""}
      </div>
    </div>
  </div>`;
}
viewDestination.after = async () => {
  const { dest: d, de, ate } = current || {};
  if (!d?.lat) return;
  bindHotelForm(d);
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const f = d.facts || {};
  // câmbio do dia
  if (f.currency && f.currency !== "BRL") {
    fetch(`https://open.er-api.com/v6/latest/${f.currency}`).then((r) => r.json()).then((j) => {
      const v = j?.rates?.BRL;
      const num = (x, dec) => x.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
      // moeda muito desvalorizada (ex.: peso argentino): mostra quanto vale R$ 1
      set("fx", !v ? esc(f.currency) : v < 0.2 ? `R$ 1 = ${num(1 / v, 1 / v >= 100 ? 0 : 2)} ${esc(f.currency)}` : `1 ${esc(f.currency)} = R$ ${num(v, 2)}`);
    }).catch(() => set("fx", esc(f.currency)));
  }
  // fuso e temperatura agora
  fetch(`https://api.open-meteo.com/v1/forecast?latitude=${d.lat}&longitude=${d.lon}&current=temperature_2m&timezone=auto&forecast_days=1`).then((r) => r.json()).then((j) => {
    const diff = Math.round((j.utc_offset_seconds - -10800) / 3600);
    const tz = diff === 0 ? "mesmo horário de Brasília" : `${diff > 0 ? "+" : ""}${diff} h em relação a Brasília`;
    set("tz", `${tz}${j.current ? ` · ${Math.round(j.current.temperature_2m)}°C agora` : ""}`);
  }).catch(() => set("tz", "–"));
  // clima: mesmas datas do ano passado (histórico real)
  let from = de, to = ate;
  if (!from) { const n = new Date(); from = isoOf(new Date(n.getFullYear(), n.getMonth() + 1, 1)); to = isoOf(new Date(n.getFullYear(), n.getMonth() + 2, 0)); }
  if (!to || to < from) to = addDays(from, 7);
  if (daysBetween(from, to) > 120) to = addDays(from, 120);
  let years = 1;
  while (addDays(to, -365 * years) > addDays(todayIso(), -6)) years++;
  const shift = (iso) => { const x = parseDate(iso); x.setFullYear(x.getFullYear() - years); return isoOf(x); };
  try {
    const j = await (await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${d.lat}&longitude=${d.lon}&start_date=${shift(from)}&end_date=${shift(to)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`)).json();
    const t = j.daily;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const rainy = t.precipitation_sum.filter((v) => v >= 1).length;
    const days = t.time.length;
    const label = de ? `${fmtShort(from)} a ${fmtShort(to)}` : fmtMonth(from);
    set("weather", `<div class="row between wrap" style="gap:12px">
        <div><div class="price-big">${Math.round(avg(t.temperature_2m_min))}° a ${Math.round(avg(t.temperature_2m_max))}°C</div><div class="muted small">mínima e máxima médias</div></div>
        <div style="text-align:right"><div class="price-big">${rainy}<small> de ${days} dias</small></div><div class="muted small">com chuva</div></div>
      </div>
      <div class="muted tiny" style="margin-top:8px">${esc(label)}: como foi o tempo nesse mesmo período ${years > 1 ? `há ${years} anos` : "no ano passado"} (dados reais da Open-Meteo).</div>`);
  } catch { set("weather", `<div class="muted small">Não foi possível carregar o clima agora.</div>`); }
};

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------
async function viewAlerts() {
  const alerts = await q(sb.from("alerts").select("*, routes(origin,destination,origin_label,destination_label)").order("created_at", { ascending: false }).limit(100));
  return `<h1>Alertas</h1>
    ${alerts.length ? `<div class="card"><div class="list">${alerts.map((a) => alertItem(a, true)).join("")}</div></div>`
      : `<div class="card empty"><div class="big">🔔</div><p>Nenhum alerta ainda.<br>Quando um preço cair abaixo do normal, ele aparece aqui e no seu WhatsApp/celular.</p></div>`}`;
}

// ---------------------------------------------------------------------------
// Formulário de rota
// ---------------------------------------------------------------------------
let form = null;

async function viewForm(id = null) {
  let r = null;
  if (id) {
    r = await q(sb.from("routes").select("*").eq("id", id).maybeSingle());
    if (!r) return `<div class="hint warn">Rota não encontrada.</div>`;
  }
  let nextMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); return isoOf(d); })();
  // atalho do Explorar: #/nova?orig=RIO&orignome=…&dest=BUE&nome=…&mes=2026-12&dias=7
  const pre = id ? null : hashParams;
  if (pre?.get("mes")) nextMonth = pre.get("mes") + "-01";
  form = {
    id,
    original: r,
    origin: r ? { code: r.origin, label: r.origin_label || r.origin } : pre?.get("orig") ? { code: pre.get("orig"), label: pre.get("orignome") || pre.get("orig") } : null,
    destination: r ? { code: r.destination, label: r.destination_label || r.destination } : pre?.get("dest") ? { code: pre.get("dest"), label: pre.get("nome") || pre.get("dest") } : null,
    trip_type: r?.trip_type || "round_trip",
    date_mode: r?.date_mode || (pre?.get("mes") ? "month" : "fixed"),
  };
  const preStay = pre?.get("dias") ? Math.max(1, Math.min(60, Number(pre.get("dias")))) : 7;
  const nextMonthEnd = (() => { const d = parseDate(nextMonth); return isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)); })();
  const v = (x, d = "") => esc(x ?? d);
  return `
    <p><a href="${id ? `#/rota/${id}` : "#/"}" class="small">← Voltar</a></p>
    <h1>${id ? "Editar rota" : "Nova rota"}</h1>
    <form id="route-form" class="stack" novalidate>
      <div class="card">
        ${placeField("origin", "De onde você sai?", "Ex.: São Paulo, GRU, Rio…")}
        ${placeField("destination", "Para onde vai?", "Ex.: Lisboa, Paris, MIA…")}
      </div>

      <div class="card">
        <span class="label">Tipo de viagem</span>
        <div class="seg" data-seg="trip_type"><button type="button" data-v="round_trip">Ida e volta</button><button type="button" data-v="one_way">Só ida</button></div>
        <div style="height:14px"></div>
        <span class="label">Datas</span>
        <div class="seg" data-seg="date_mode"><button type="button" data-v="fixed">Data fixa</button><button type="button" data-v="month">Mês inteiro</button><button type="button" data-v="long">Viagem longa</button></div>

        <div data-show="fixed" style="margin-top:14px">
          <div class="grid2">
            <label class="field"><span>Ida</span><input class="input" type="date" name="depart_date" min="${todayIso()}" value="${v(r?.depart_date)}"></label>
            <label class="field" data-show="round_trip"><span>Volta</span><input class="input" type="date" name="return_date" min="${todayIso()}" value="${v(r?.return_date)}"></label>
          </div>
        </div>
        <div data-show="month" style="margin-top:14px">
          <div class="grid2">
            <label class="field"><span>Mês da ida</span><input class="input" type="month" name="month" min="${todayIso().slice(0, 7)}" value="${v((r?.month || nextMonth).slice(0, 7))}"></label>
            <label class="field" data-show="round_trip"><span>Dias de viagem</span><input class="input" type="number" name="stay_days" min="1" max="60" inputmode="numeric" value="${v(r?.stay_days, preStay)}"></label>
          </div>
          <p class="muted small" style="margin:10px 0 0">O robô acompanha todos os dias do mês e te avisa quais estão mais baratos.</p>
        </div>
        <div data-show="long" style="margin-top:14px">
          <div class="grid2">
            <label class="field"><span>Ida a partir de</span><input class="input" type="date" name="depart_from" min="${todayIso()}" value="${v(r?.depart_from || nextMonth)}"></label>
            <label class="field"><span>Ida até</span><input class="input" type="date" name="depart_to" min="${todayIso()}" value="${v(r?.depart_to || nextMonthEnd)}"></label>
          </div>
          <div class="grid2" data-show="round_trip">
            <label class="field"><span>Volta no mínimo (dias depois da ida)</span><input class="input" type="number" name="min_stay" min="1" max="330" inputmode="numeric" value="${v(r?.min_stay, 30)}"></label>
            <label class="field"><span>Volta no máximo (dias depois da ida)</span><input class="input" type="number" name="max_stay" min="1" max="330" inputmode="numeric" value="${v(r?.max_stay, 90)}"></label>
          </div>
          <label class="switch" style="margin-top:6px"><span>Acompanhar também só voos diretos, separado</span><input type="checkbox" name="track_direct" ${r?.track_direct ? "checked" : ""}></label>
          <p class="muted small" style="margin:6px 0 0">O robô acompanha a ida e a volta separadas (duas passagens só de ida, podem ser de companhias diferentes) e soma o melhor total. Em viagens de até 30 dias, também compara com a passagem de ida e volta. Na Europa (Schengen), brasileiro pode ficar até 90 dias a cada 180.</p>
        </div>
      </div>

      <div class="card">
        <div class="grid2">
          <div class="field"><span>Adultos</span>
            <div class="stepper"><button type="button" data-step="-1">−</button><output name="adults">${r?.adults || 1}</output><button type="button" data-step="1">+</button></div>
          </div>
          <label class="field"><span>Escalas</span>
            <select class="input" name="max_stops">
              <option value="">Qualquer</option>
              <option value="1" ${r?.max_stops === 1 ? "selected" : ""}>Até 1 escala</option>
              <option value="0" ${r?.max_stops === 0 ? "selected" : ""}>Só voo direto</option>
            </select>
          </label>
        </div>
      </div>

      <div class="card">
        <span class="label">Me avise quando o preço ficar</span>
        <div class="range-row"><input type="range" name="threshold_pct" min="5" max="40" step="1" value="${r?.threshold_pct || 15}"><output id="thr-out">${r?.threshold_pct || 15}%</output></div>
        <p class="muted small" style="margin:4px 0 14px">abaixo do preço normal para a data.</p>
        <label class="field"><span>Ou abaixo deste valor (opcional, total em R$)</span><input class="input" type="number" name="target_price" min="1" inputmode="numeric" placeholder="Ex.: 3500" value="${v(r?.target_price)}"></label>
        <label class="field"><span>Verificar a cada</span>
          <select class="input" name="check_every_hours">
            ${[1, 2, 3, 6, 12].map((h) => `<option value="${h}" ${(r?.check_every_hours || 3) === h ? "selected" : ""}>${h} hora${h > 1 ? "s" : ""}${h === 3 ? " (recomendado)" : ""}</option>`).join("")}
          </select>
        </label>
      </div>

      ${id ? `<p class="muted small">Se você mudar origem, destino, datas, passageiros ou escalas, o histórico de preços desta rota recomeça (os alertas antigos ficam guardados).</p>` : ""}
      <div id="form-msg"></div>
      <button class="btn primary block" type="submit">${id ? "Salvar alterações" : "Começar a monitorar"}</button>
    </form>`;
}

function placeField(name, label, placeholder) {
  const cur = form[name];
  return `<div class="field ac" data-place="${name}">
    <span>${label}</span>
    <input class="input" type="text" autocomplete="off" autocapitalize="words" placeholder="${placeholder}" value="${cur ? esc(`${cur.label} (${cur.code})`) : ""}">
    <div class="ac-list" hidden></div>
    <div class="chosen"></div>
  </div>`;
}

viewForm.after = () => {
  const el = document.getElementById("route-form");
  if (!el) return;
  const sync = () => {
    el.querySelectorAll("[data-seg]").forEach((s) => s.querySelectorAll("button").forEach((b) => b.classList.toggle("on", form[s.dataset.seg] === b.dataset.v)));
    el.querySelectorAll("[data-show]").forEach((x) => {
      const k = x.dataset.show;
      x.hidden = k === "round_trip" ? form.trip_type !== "round_trip" : form.date_mode !== k;
    });
  };
  sync();
  el.querySelectorAll("[data-seg]").forEach((s) => s.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    form[s.dataset.seg] = b.dataset.v; sync();
  }));
  el.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const out = el.querySelector("output[name=adults]");
    out.value = out.textContent = String(Math.min(9, Math.max(1, Number(out.textContent) + Number(b.dataset.step))));
  }));
  const thr = el.querySelector("[name=threshold_pct]");
  thr.addEventListener("input", () => (document.getElementById("thr-out").textContent = thr.value + "%"));
  el.querySelector("[name=depart_date]").addEventListener("change", (e) => {
    const ret = el.querySelector("[name=return_date]");
    ret.min = e.target.value || todayIso();
    if (ret.value && ret.value <= e.target.value) ret.value = "";
  });
  el.querySelectorAll("[data-place]").forEach(setupAutocomplete);
  el.addEventListener("submit", saveRoute);
};

function setupAutocomplete(wrap) {
  const name = wrap.dataset.place;
  const input = wrap.querySelector("input");
  const list = wrap.querySelector(".ac-list");
  const chosen = wrap.querySelector(".chosen");
  let timer, seq = 0, items = [];
  const close = () => (list.hidden = true);
  const labelOf = (it) => (it.type === "city" ? it.name : it.city_name || it.name);
  const subOf = (it) => (it.type === "city" ? `todos os aeroportos · ${it.country_name}` : `${it.name} · ${it.country_name}`);
  const showChosen = () => {
    const c = form[name];
    chosen.innerHTML = c ? `✓ <b>${esc(c.label)}</b> (${esc(c.code)})${c.sub ? ` · ${esc(c.sub)}` : ""}` : "";
  };
  const pick = (it) => {
    form[name] = { code: it.code, label: labelOf(it), sub: subOf(it) };
    input.value = `${labelOf(it)} (${it.code})`;
    showChosen();
    close();
  };
  showChosen();

  async function search(term) {
    const my = ++seq;
    try {
      const url = `https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(term)}&locale=pt&types[]=city&types[]=airport`;
      const found = (await (await fetch(url)).json()).slice(0, 8);
      if (my !== seq) return;
      items = found;
      list.innerHTML = items.length
        ? items.map((it, i) => `<button type="button" data-i="${i}"><span class="code">${esc(it.code)}</span><span class="grow"><b>${esc(labelOf(it))}</b><br><span class="muted tiny">${esc(subOf(it))}</span></span></button>`).join("")
        : `<div class="muted small" style="padding:10px">Nada encontrado. Tente outro nome ou o código de 3 letras (ex.: GRU).</div>`;
      list.hidden = document.activeElement !== input;
    } catch { close(); }
  }

  // pointerdown escolhe antes do campo perder o foco (funciona no celular e no computador)
  list.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button[data-i]"); if (!b) return;
    e.preventDefault();
    pick(items[Number(b.dataset.i)]);
  });
  input.addEventListener("focus", () => { input.select(); if (items.length && !form[name]) list.hidden = false; });
  input.addEventListener("input", () => {
    form[name] = null;
    showChosen();
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) { items = []; close(); return; }
    timer = setTimeout(() => search(term), 200);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && items.length && !list.hidden) { e.preventDefault(); pick(items[0]); }
    if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(() => {
    close();
    if (form[name]) return;
    if (items.length) { pick(items[0]); return; }  // saiu sem escolher: usa a primeira sugestão
    const raw = input.value.trim();
    if (/^[a-z]{3}$/i.test(raw)) {
      form[name] = { code: raw.toUpperCase(), label: raw.toUpperCase() };
      input.value = raw.toUpperCase();
      showChosen();
    }
  }, 150));
}

async function saveRoute(e) {
  e.preventDefault();
  const el = e.target;
  const msg = document.getElementById("form-msg");
  const fail = (t) => { msg.innerHTML = `<div class="hint bad">${esc(t)}</div>`; msg.scrollIntoView({ block: "center", behavior: "smooth" }); };
  msg.innerHTML = "";
  const rt = form.trip_type === "round_trip";
  const today = todayIso();
  if (!form.origin) return fail("Escolha a origem na lista (ou digite o código de 3 letras).");
  if (!form.destination) return fail("Escolha o destino na lista (ou digite o código de 3 letras).");
  if (form.origin.code === form.destination.code) return fail("Origem e destino precisam ser diferentes.");

  const row = {
    origin: form.origin.code, origin_label: form.origin.label,
    destination: form.destination.code, destination_label: form.destination.label,
    trip_type: form.trip_type, date_mode: form.date_mode,
    depart_date: null, return_date: null, month: null, stay_days: null,
    depart_from: null, depart_to: null, min_stay: null, max_stay: null, track_direct: false,
    adults: Number(el.querySelector("output[name=adults]").textContent),
    max_stops: el.max_stops.value === "" ? null : Number(el.max_stops.value),
    threshold_pct: Number(el.threshold_pct.value),
    target_price: el.target_price.value ? Number(el.target_price.value) : null,
    check_every_hours: Number(el.check_every_hours.value),
    check_requested_at: new Date().toISOString(),
    last_error: null,
  };
  if (form.date_mode === "fixed") {
    row.depart_date = el.depart_date.value;
    if (!row.depart_date || row.depart_date <= today) return fail("Escolha uma data de ida a partir de amanhã.");
    if (rt) {
      row.return_date = el.return_date.value;
      if (!row.return_date || row.return_date <= row.depart_date) return fail("A volta precisa ser depois da ida.");
    }
  } else if (form.date_mode === "long") {
    row.depart_from = el.depart_from.value;
    row.depart_to = el.depart_to.value;
    if (!row.depart_from || row.depart_from <= today) return fail("A ida precisa começar a partir de amanhã.");
    if (!row.depart_to || row.depart_to < row.depart_from) return fail("O último dia da ida precisa ser depois do primeiro.");
    if (daysBetween(row.depart_from, row.depart_to) > 62) return fail("A janela de ida pode ter no máximo 2 meses.");
    row.track_direct = el.track_direct.checked && row.max_stops !== 0;
    if (rt) {
      row.min_stay = Number(el.min_stay.value);
      row.max_stay = Number(el.max_stay.value);
      if (!(row.max_stay >= 1 && row.max_stay <= 330)) return fail("Volta no máximo: entre 1 e 330 dias.");
      if (!(row.min_stay >= 1 && row.min_stay <= row.max_stay)) return fail("O mínimo de dias precisa ser menor que o máximo.");
      if (row.max_stay - row.min_stay > 120) return fail("Entre o mínimo e o máximo de dias cabem no máximo 120 dias.");
    }
  } else {
    if (!el.month.value) return fail("Escolha o mês da viagem.");
    row.month = el.month.value + "-01";
    if (row.month.slice(0, 7) < today.slice(0, 7)) return fail("Esse mês já passou.");
    if (rt) {
      row.stay_days = Number(el.stay_days.value);
      if (!(row.stay_days >= 1 && row.stay_days <= 60)) return fail("Dias de viagem: entre 1 e 60.");
    }
  }

  const btn = el.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    let id = form.id;
    if (id) {
      const o = form.original;
      const searchChanged = ["origin", "destination", "trip_type", "date_mode", "depart_date", "return_date", "month", "stay_days", "depart_from", "depart_to", "min_stay", "max_stay", "track_direct", "adults", "max_stops"]
        .some((k) => String(o[k] ?? "") !== String(row[k] ?? ""));
      await q(sb.from("routes").update(row).eq("id", id));
      if (searchChanged) {
        await q(sb.from("price_snapshots").delete().eq("route_id", id));
        await q(sb.from("price_observations").delete().eq("route_id", id));
      }
    } else {
      const created = await q(sb.from("routes").insert({ ...row, active: true }).select("id").single());
      id = created.id;
    }
    toast(form.id ? "Rota atualizada! Nova verificação em até ~15 min." : "Rota criada! A primeira verificação sai em até ~15 min.", 4500);
    location.hash = `#/rota/${id}`;
  } catch (err) {
    fail(friendlyError(err));
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Ajustes: notificações, status do robô, conta
// ---------------------------------------------------------------------------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlB64ToUint8Array(b64) {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || isIOS) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Navegador";
}

async function currentPushSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function pushBlock() {
  if (isIOS && !isStandalone) {
    return `<div class="hint">No iPhone, as notificações só funcionam com o app instalado: no <b>Safari</b>, toque em <b>Compartilhar</b> (quadrado com seta) → <b>Adicionar à Tela de Início</b>. Depois abra o Radar pelo ícone e volte aqui.</div>`;
  }
  if (!pushSupported) return `<div class="hint warn">Este navegador não suporta notificações. Use o Chrome (Android/computador) ou o app instalado no iPhone.</div>`;
  if (Notification.permission === "denied") return `<div class="hint warn">As notificações estão bloqueadas para este site. Libere nas configurações do navegador/celular e volte aqui.</div>`;
  const sub = await currentPushSub();
  return sub
    ? `<div class="row between"><span>✅ Notificações ativas neste aparelho</span><button class="btn sm" id="push-off">Desativar</button></div>`
    : `<button class="btn primary block" id="push-on">🔔 Ativar notificações neste aparelho</button>`;
}

async function viewSettings() {
  const [settings, runs, subs] = await Promise.all([
    updateBotStatus(),
    q(sb.from("bot_runs").select("*").order("started_at", { ascending: false }).limit(8)),
    q(sb.from("push_subscriptions").select("device,created_at")),
  ]);
  const s = settings || {};
  const ch = s.bot_channels || {};
  const hb = s.bot_heartbeat_at;
  const mins = hb ? (Date.now() - new Date(hb)) / 60000 : Infinity;
  const yes = (b) => (b ? `<span class="badge good">configurado</span>` : `<span class="badge">não configurado</span>`);
  const testPending = s.test_requested_at && (!s.test_done_at || s.test_requested_at > s.test_done_at);
  return `<h1>Ajustes</h1>
    <h2>Notificações neste aparelho</h2>
    <div class="card" id="push-block">${await pushBlock()}</div>

    <h2>Onde receber os alertas</h2>
    <div class="card">
      <label class="switch"><span>WhatsApp ${yes(ch.whatsapp)}</span><input type="checkbox" data-set="notify_whatsapp" ${s.notify_whatsapp !== false ? "checked" : ""}></label>
      <label class="switch"><span>Notificação do app <span class="muted small">(${subs.length} aparelho${subs.length === 1 ? "" : "s"})</span></span><input type="checkbox" data-set="notify_push" ${s.notify_push !== false ? "checked" : ""}></label>
      <label class="switch"><span>Telegram ${yes(ch.telegram)}</span><input type="checkbox" data-set="notify_telegram" ${s.notify_telegram !== false ? "checked" : ""}></label>
      <button class="btn block" id="test-btn" style="margin-top:12px" ${testPending ? "disabled" : ""}>${testPending ? "Teste pedido: chega em até ~15 min" : "Enviar notificação de teste"}</button>
    </div>

    <h2>Robô</h2>
    <div class="card">
      <dl class="kv">
        <dt>Situação</dt><dd>${!hb ? "ainda não rodou" : mins < 75 ? "✅ ativo" : mins < 240 ? "⚠️ atrasado" : "❌ parado"}</dd>
        <dt>Última execução</dt><dd>${hb ? `${fmtDateTime(hb)} (${ago(hb)})` : "–"}</dd>
        <dt>Google Flights</dt><dd>sempre ativo</dd>
        <dt>Aviasales</dt><dd>${ch.aviasales ? "ativo" : "sem token"}</dd>
      </dl>
      ${runs.length ? `<div class="list" style="margin-top:14px">${runs.map((r) => `<div class="item"><div class="grow">
        <div class="row between"><b class="small">${fmtDateTime(r.started_at)}</b><span class="badge ${r.status === "ok" ? "good" : r.status === "running" ? "" : "warn"}">${r.status === "ok" ? "ok" : r.status === "running" ? "rodando" : "com avisos"}</span></div>
        <pre class="log">${esc(r.summary || "")}</pre></div></div>`).join("")}</div>` : ""}
    </div>

    <h2>Instalar no celular</h2>
    <div class="card small">
      <p style="margin-top:0"><b>iPhone:</b> abra este link no Safari → Compartilhar → <b>Adicionar à Tela de Início</b>.</p>
      <p style="margin-bottom:0"><b>Android:</b> no Chrome, menu ⋮ → <b>Instalar app</b> (ou Adicionar à tela inicial).</p>
    </div>

    <h2>Conta</h2>
    <div class="card"><div class="row between"><span class="ellipsis">${esc(session?.user?.email)}</span><button class="btn sm" id="logout">Sair</button></div></div>`;
}
viewSettings.after = () => {
  document.querySelectorAll("[data-set]").forEach((inp) => inp.addEventListener("change", async () => {
    try {
      await q(sb.from("settings").update({ [inp.dataset.set]: inp.checked }).eq("id", 1));
      toast("Salvo.");
    } catch (err) { inp.checked = !inp.checked; toast(friendlyError(err)); }
  }));
  document.getElementById("test-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await q(sb.from("settings").update({ test_requested_at: new Date().toISOString() }).eq("id", 1));
      e.target.textContent = "Teste pedido: chega em até ~15 min";
      toast("Teste pedido! O robô envia na próxima rodada (até ~15 min).");
    } catch (err) { e.target.disabled = false; toast(friendlyError(err)); }
  });
  document.getElementById("logout").addEventListener("click", async () => {
    await sb.auth.signOut();
    location.hash = "#/login";
  });
  bindPush();
};

function bindPush() {
  document.getElementById("push-on")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Você não permitiu as notificações.");
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      await q(sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName() }));
      toast("Notificações ativadas! Use “Enviar notificação de teste” para conferir.", 4500);
      render();
    } catch (err) { e.target.disabled = false; toast(friendlyError(err), 5000); }
  });
  document.getElementById("push-off")?.addEventListener("click", async () => {
    const sub = await currentPushSub();
    if (sub) {
      await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
    toast("Notificações desativadas neste aparelho.");
    render();
  });
}

// ---------------------------------------------------------------------------
// Início do app
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));

sb.auth.onAuthStateChange((event, s) => {
  const was = !!session;
  session = s;
  if (event === "SIGNED_IN" && !was) { location.hash = "#/"; render(); }
  if (event === "SIGNED_OUT") { $bot.hidden = true; render(); }
});
window.addEventListener("hashchange", render);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session && !location.hash.startsWith("#/nova") && !location.hash.startsWith("#/editar")) render();
});

const { data } = await sb.auth.getSession();
session = data.session;
render();
