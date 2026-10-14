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
  if (/Limite de 3 rotas/.test(m)) return "Você já tem 3 rotas ativas. Pause ou apague uma antes.";
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
  const stay = r.trip_type === "round_trip" ? ` · ${r.stay_days} dias de viagem` : "";
  return `${kind} · ${fmtMonth(r.month)} inteiro${stay}${pax}${stops}`;
}

// Só considera preços das datas que a rota acompanha hoje (se você editou as datas, ignora as antigas)
function inScope(r, row) {
  if (row.depart_date < todayIso()) return false;
  if (r.date_mode === "fixed") {
    return row.depart_date === r.depart_date && (r.trip_type === "one_way" ? !row.return_date : row.return_date === r.return_date);
  }
  if (row.depart_date.slice(0, 7) !== r.month.slice(0, 7)) return false;
  if (r.trip_type === "one_way") return !row.return_date;
  return row.return_date && daysBetween(row.depart_date, row.return_date) === r.stay_days;
}

function googleUrl(r, dep, ret) {
  const text = `Flights from ${r.origin} to ${r.destination} on ${dep}` + (ret ? ` through ${ret}` : " one way") + (r.adults > 1 ? ` for ${r.adults} adults` : "");
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
  [/^#\/nova$/, viewForm],
  [/^#\/editar\/([\w-]+)$/, viewForm],
  [/^#\/rota\/([\w-]+)$/, viewRoute],
  [/^#\/alertas$/, viewAlerts],
  [/^#\/config$/, viewSettings],
];

async function render() {
  const hash = location.hash || "#/";
  if (!session && hash !== "#/login") { location.replace("#/login"); return; }
  if (session && hash === "#/login") { location.replace("#/"); return; }
  $tabs.hidden = !session;
  const tab = hash.startsWith("#/alertas") ? "alertas" : hash.startsWith("#/config") ? "config" : "rotas";
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
  const [routes, latest, trend] = await Promise.all([
    q(sb.from("routes").select("*").order("created_at")),
    q(sb.from("route_latest").select("route_id,depart_date,return_date,price,normal_price,checked_at").gte("depart_date", todayIso()).limit(1000)),
    q(sb.from("route_trend").select("route_id,checked_at,best_price").gte("checked_at", isoDaysAgo(10)).order("checked_at").limit(1000)),
  ]);
  updateBotStatus();
  const active = routes.filter((r) => r.active).length;
  const canAdd = active < MAX_ROUTES;
  const head = `<div class="row between"><h1>Suas rotas</h1><span class="muted small">${active} de ${MAX_ROUTES} ativas</span></div>`;
  if (!routes.length) {
    return `${head}<div class="card empty"><div class="big">✈️</div>
      <p><b>Nenhuma rota ainda.</b><br>Cadastre a viagem que você quer acompanhar e o robô começa a vigiar os preços.</p>
      <a class="btn primary" href="#/nova">Cadastrar primeira rota</a></div>`;
  }
  const cards = routes.map((r) => {
    const rows = latest.filter((x) => x.route_id === r.id && inScope(r, x));
    const best = rows.reduce((a, b) => (!a || b.price < a.price ? b : a), null);
    const normal = best?.normal_price ?? (r.date_mode === "month" ? median(rows.map((x) => Number(x.price))) : null);
    const lv = best ? level(Number(best.price), normal ? Number(normal) : null, r.threshold_pct) : null;
    const spark = sparkline(trend.filter((t) => t.route_id === r.id).map((t) => Number(t.best_price)));
    const when = best ? (best.return_date ? `${fmtDay(best.depart_date)} → ${fmtDay(best.return_date)}` : fmtDay(best.depart_date)) : "";
    return `<a class="card route-card" href="#/rota/${r.id}">
      <div class="row between" style="align-items:flex-start">
        <div class="grow">
          <div class="od ellipsis">${esc(place(r, "origin"))}<span class="arrow">→</span>${esc(place(r, "destination"))}</div>
          <div class="meta">${esc(tripLabel(r))}</div>
        </div>
        ${!r.active ? `<span class="badge paused">pausada</span>` : ""}
      </div>
      <div class="row between wrap" style="margin-top:12px">
        <div>
          <div class="price-big">${best ? brl(best.price) : "…"} ${best && r.date_mode === "month" ? `<small>em ${esc(when)}</small>` : ""}</div>
          <div class="muted small">${best ? `normal ~${brl(normal)} · ${ago(best.checked_at)}` : r.active ? "aguardando a primeira verificação" : ""}</div>
        </div>
        ${lv ? `<span class="badge ${lv.cls}">${esc(lv.label)}</span>` : ""}
      </div>
      ${spark}
      ${r.last_error ? `<div class="error-line">⚠️ ${esc(r.last_error)}</div>` : ""}
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
    q(sb.from("route_latest").select("*").eq("route_id", id).gte("depart_date", todayIso()).limit(1000)),
    q(sb.from("route_trend").select("checked_at,best_price,normal_price").eq("route_id", id).gte("checked_at", isoDaysAgo(30)).order("checked_at").limit(1000)),
    q(sb.from("alerts").select("*").eq("route_id", id).order("created_at", { ascending: false }).limit(15)),
  ]);
  if (!route) return `<div class="hint warn">Rota não encontrada.</div><p><a class="btn" href="#/">Voltar</a></p>`;
  const latest = latestAll.filter((x) => inScope(route, x));
  const best = latest.reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null);
  const monthMedian = median(latest.map((x) => Number(x.price)));
  const normalOf = (row) => (row?.normal_price != null ? Number(row.normal_price) : route.date_mode === "month" ? monthMedian : null);
  current = { route, latest, normalOf };

  const bestCard = best ? priceCard(route, best, normalOf(best), "Menor preço agora") : `<div class="card"><div class="muted">${route.active ? "Ainda sem preços. O robô verifica em até ~15 min depois de cadastrar." : "Rota pausada."}</div></div>`;
  const nextCheck = route.last_checked_at ? new Date(new Date(route.last_checked_at).getTime() + route.check_every_hours * 3600000) : null;
  const requested = route.check_requested_at && (!route.last_checked_at || route.check_requested_at > route.last_checked_at);

  return `
    <p><a href="#/" class="small">← Rotas</a></p>
    <div class="row between" style="align-items:flex-start">
      <div class="grow"><h1 style="margin-bottom:4px">${esc(place(route, "origin"))} → ${esc(place(route, "destination"))}</h1>
      <div class="muted small">${esc(tripLabel(route))}</div></div>
      ${!route.active ? `<span class="badge paused">pausada</span>` : ""}
    </div>
    ${route.last_error ? `<div class="hint warn" style="margin-top:12px">⚠️ ${esc(route.last_error)}</div>` : ""}
    <div style="margin-top:16px">${bestCard}</div>

    ${route.date_mode === "month" ? `<h2>Calendário de ${esc(fmtMonth(route.month))}</h2><div class="card">${calendar(route, latest, normalOf, best)}<div id="day-detail"></div></div>` : ""}

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
  document.querySelector(".cal")?.addEventListener("click", (e) => {
    const cell = e.target.closest(".day[data-d]"); if (!cell) return;
    document.querySelectorAll(".cal .day.sel").forEach((x) => x.classList.remove("sel"));
    cell.classList.add("sel");
    const row = current.latest.find((x) => x.depart_date === cell.dataset.d);
    document.getElementById("day-detail").innerHTML = row ? `<div style="margin-top:12px">${priceCard(current.route, row, current.normalOf(row), "Dia selecionado")}</div>` : "";
  });
};

function priceCard(route, row, normal, title) {
  const lv = level(Number(row.price), normal, route.threshold_pct);
  const dates = row.return_date ? `${fmtDay(row.depart_date)} → ${fmtDay(row.return_date)}` : fmtDay(row.depart_date);
  const details = [row.airline, stopsLabel(row.stops), sourceLabel(row.source)].filter(Boolean).join(" · ");
  const gLink = row.source === "google" && row.link ? row.link : googleUrl(route, row.depart_date, row.return_date);
  const aLink = row.source === "aviasales" && row.link ? row.link : null;
  return `<div class="card">
    <div class="muted small">${esc(title)}</div>
    <div class="row between wrap" style="margin-top:4px">
      <div class="price-big">${brl(row.price)}</div>
      <span class="badge ${lv.cls}">${esc(lv.label)}</span>
    </div>
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
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const byDay = Object.fromEntries(latest.map((x) => [x.depart_date, x]));
  const today = todayIso();
  let html = WD.map((w) => `<div class="wd">${w}</div>`).join("");
  html += `<div></div>`.repeat(first.getDay());
  for (let d = 1; d <= days; d++) {
    const iso = isoOf(new Date(first.getFullYear(), first.getMonth(), d));
    const row = byDay[iso];
    if (iso <= today) { html += `<div class="day past"><span class="n">${d}</span></div>`; continue; }
    if (!row) { html += `<div class="day none"><span class="n">${d}</span><span class="p">–</span></div>`; continue; }
    const p = pct(Number(row.price), normalOf(row));
    const cls = p == null ? "lvl-mid" : p >= 5 ? "lvl-good" : p > -8 ? "lvl-mid" : p > -20 ? "lvl-warn" : "lvl-bad";
    html += `<button type="button" class="day ${cls} ${best && best.depart_date === iso ? "best" : ""}" data-d="${iso}"><span class="n">${d}</span><span class="p">${compactBrl(row.price)}</span></button>`;
  }
  return `<div class="cal">${html}</div>
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
      <div class="small">${esc(dates)}${a.normal_price ? ` · normal ~${brl(a.normal_price)}` : ""}</div>
      <div class="muted small">${esc((a.reasons || []).join("; "))}</div>
      <div class="row wrap tiny muted" style="gap:8px;margin-top:4px">
        ${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">abrir oferta ↗</a>` : ""}
        <span>${a.channels?.length ? "enviado por " + esc(a.channels.join(", ")) : "não enviado (sem canal configurado)"}</span>
      </div>
    </div>
  </div>`;
}

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
  const nextMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); return isoOf(d); })();
  form = {
    id,
    original: r,
    origin: r ? { code: r.origin, label: r.origin_label || r.origin } : null,
    destination: r ? { code: r.destination, label: r.destination_label || r.destination } : null,
    trip_type: r?.trip_type || "round_trip",
    date_mode: r?.date_mode || "fixed",
  };
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
        <div class="seg" data-seg="date_mode"><button type="button" data-v="fixed">Data fixa</button><button type="button" data-v="month">Mês inteiro (data aberta)</button></div>

        <div data-show="fixed" style="margin-top:14px">
          <div class="grid2">
            <label class="field"><span>Ida</span><input class="input" type="date" name="depart_date" min="${todayIso()}" value="${v(r?.depart_date)}"></label>
            <label class="field" data-show="round_trip"><span>Volta</span><input class="input" type="date" name="return_date" min="${todayIso()}" value="${v(r?.return_date)}"></label>
          </div>
        </div>
        <div data-show="month" style="margin-top:14px">
          <div class="grid2">
            <label class="field"><span>Mês da ida</span><input class="input" type="month" name="month" min="${todayIso().slice(0, 7)}" value="${v((r?.month || nextMonth).slice(0, 7))}"></label>
            <label class="field" data-show="round_trip"><span>Dias de viagem</span><input class="input" type="number" name="stay_days" min="1" max="60" inputmode="numeric" value="${v(r?.stay_days, 7)}"></label>
          </div>
          <p class="muted small" style="margin:10px 0 0">O robô acompanha todos os dias do mês e te avisa quais estão mais baratos.</p>
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
      const searchChanged = ["origin", "destination", "trip_type", "date_mode", "depart_date", "return_date", "month", "stay_days", "adults", "max_stops"]
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
