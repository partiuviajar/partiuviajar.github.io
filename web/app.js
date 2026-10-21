// Radar de Voos: roteador e casca do app (cabeçalho, menu, status do robô).
import { sb, S, q, esc, friendlyError, fmtDateTime, invalidate, loadFavs, toggleFav, heartIcon, setAmbient } from "./js/core.js";
import { icon } from "./js/icons.js";
import { viewHome } from "./js/views/home.js";
import { viewRoutes, viewRoute, viewForm, viewExplore } from "./js/views/routes.js";
import { viewGuideIndex, viewGuide } from "./js/views/guide.js";
import { viewStay, viewHotels } from "./js/views/stay.js";
import { viewAlerts, viewSettings, viewLogin, viewFavorites } from "./js/views/misc.js";
import { viewCopilot, viewCopilotForm, viewCopilotResult } from "./js/views/copilot.js";
import { loadProfile, loadUsage, gateScreen, upgradeFab, openUpgrade, handleLimitError, viewPlans, viewAdmin, isAdmin } from "./js/plans.js";

const $view = document.getElementById("view");
const SKELETON = `<main class="page"><div class="skeleton" style="height:180px;border-radius:var(--r-3xl)"></div><div class="skeleton" style="height:96px"></div><div class="skeleton" style="height:96px"></div></main>`;

// cada tela devolve o HTML; se tiver .after, roda depois de desenhar (liga botões etc.)
const ROUTES = [
  [/^#\/login$/, viewLogin],
  [/^#\/?$/, viewHome],
  [/^#\/rotas$/, viewRoutes],
  [/^#\/rota\/([\w-]+)$/, viewRoute],
  [/^#\/nova$/, viewForm],
  [/^#\/editar\/([\w-]+)$/, viewForm],
  [/^#\/explorar$/, viewExplore],
  [/^#\/guide$/, viewGuideIndex],
  [/^#\/guide\/([A-Z0-9]{3})$/, viewGuide],
  [/^#\/destino\/([A-Z0-9]{3})$/, viewGuide],   // endereço antigo
  [/^#\/hospedagem$/, viewStay],
  [/^#\/viagem$/, viewStay],                     // endereço antigo
  [/^#\/hoteis\/([\w-]+)$/, viewHotels],
  [/^#\/alertas$/, viewAlerts],
  [/^#\/config$/, viewSettings],
  [/^#\/favoritos$/, viewFavorites],
  [/^#\/planos$/, viewPlans],
  [/^#\/admin$/, viewAdmin],
  [/^#\/copiloto$/, viewCopilot],
  [/^#\/copiloto\/novo$/, viewCopilotForm],
  [/^#\/copiloto\/([\w-]+)$/, viewCopilotResult],
];

const TABS = [
  ["#/", "Home", "house", (h) => h === "#/" || h === "#"],
  ["#/rotas", "Rotas", "plane", (h) => /^#\/(rota|nova|editar|explorar)/.test(h)],
  ["#/copiloto", "Copiloto", "sparkles", (h) => h.startsWith("#/copiloto")],
  ["#/guide", "Guide", "earth", (h) => /^#\/(guide|destino)/.test(h)],
  ["#/hospedagem", "Hospedagem", "bed-double", (h) => /^#\/(hospedagem|hoteis|viagem)/.test(h)],
];

function shell(hash, logged) {
  document.getElementById("topbar").hidden = !logged;
  document.getElementById("tabs").hidden = !logged;
  if (!logged) return;
  document.getElementById("tabs-in").innerHTML = TABS.map(([href, label, ic, active]) => {
    const on = active(hash);
    return `<a class="tab pressable ${on ? "active" : ""} ${label === "Copiloto" ? "tab-copilot" : ""}" href="${href}"><span class="tab-ic">${icon(ic, 20, "", on ? 2.4 : 2)}</span><span>${label}</span></a>`;
  }).join("");
  document.getElementById("upgrade-fab")?.remove();
  const fab = upgradeFab();
  if (fab && !/^#\/(admin|planos|login)/.test(hash)) {
    document.body.insertAdjacentHTML("beforeend", fab);
    document.getElementById("upgrade-fab").addEventListener("click", () => openUpgrade());
  }
  const bell = document.getElementById("alerts-btn");
  bell.classList.toggle("on", hash.startsWith("#/alertas"));
  bell.querySelector(".tab-badge")?.remove();
  if (S.newAlerts) bell.insertAdjacentHTML("beforeend", `<span class="tab-badge" style="right:-4px;top:-4px">${S.newAlerts}</span>`);
  document.getElementById("settings-btn").classList.toggle("on", hash.startsWith("#/config"));
  document.getElementById("favs-btn").classList.toggle("on", hash.startsWith("#/favoritos"));
}

async function render() {
  const [hash, query = ""] = (location.hash || "#/").split("?");
  S.params = new URLSearchParams(query);
  const logged = !!S.session;
  if (!logged && hash !== "#/login") { location.replace("#/login"); return; }
  if (logged && hash === "#/login") { location.replace("#/"); return; }
  if (logged && !S.profile) await loadProfile();
  const gated = logged && S.profile && S.profile.status !== "active";
  shell(hash, logged && !gated);
  if (gated) {
    $view.innerHTML = gateScreen();
    document.getElementById("gate-out")?.addEventListener("click", async () => { await sb.auth.signOut(); location.hash = "#/login"; });
    return;
  }
  const seq = ++S.seq;
  S.ambient = null;  // a tela define a foto de fundo, se tiver
  const match = ROUTES.find(([re]) => re.test(hash));
  if (!match) { location.replace("#/"); return; }
  const args = hash.match(match[0]).slice(1);
  // se a tela demorar, mostra esqueleto na hora (antes ficava parado na tela anterior)
  const slow = setTimeout(() => { if (seq === S.seq) $view.innerHTML = SKELETON; }, 120);
  try {
    const html = await match[1](...args);
    clearTimeout(slow);
    if (seq !== S.seq) return;
    if (typeof html === "string") $view.innerHTML = html;
    window.scrollTo(0, 0);
    setAmbient(S.ambient);
    await match[1].after?.(...args);
  } catch (e) {
    clearTimeout(slow);
    if (seq !== S.seq) return;
    console.error(e);
    $view.innerHTML = `<main class="page"><div class="card pad center"><h1 class="lg xb">Essa página não carregou</h1><p class="sm muted" style="margin:6px 0 14px">${esc(friendlyError(e))}</p>
      <button class="btn primary" onclick="location.reload()">Tentar de novo</button></div></main>`;
  }
}

// status do robô no topo + contagem de alertas novos (últimas 24 h) no menu
async function updateBotStatus() {
  const el = document.getElementById("bot-status");
  try {
    const [s, alerts] = await Promise.all([
      q(sb.from("settings").select("bot_heartbeat_at").eq("id", 1).maybeSingle()),
      q(sb.from("alerts").select("id").gte("created_at", new Date(Date.now() - 86400000).toISOString())),
    ]);
    const hb = s?.bot_heartbeat_at;
    const mins = hb ? (Date.now() - new Date(hb)) / 60000 : Infinity;
    el.className = "bot-pill " + (mins < 75 ? "" : mins < 240 ? "late" : "off");
    el.querySelector("span").textContent = !hb ? "Robô parado" : mins < 75 ? "Robô ativo" : mins < 240 ? "Robô atrasado" : "Robô parado";
    el.title = hb ? `Última execução: ${fmtDateTime(hb)}` : "";
    el.hidden = false;
    if (S.newAlerts !== alerts.length) { S.newAlerts = alerts.length; shell((location.hash || "#/").split("?")[0], true); }
    if (isAdmin() && !S.profile?.legacy) {
      const [p, u] = await Promise.all([
        sb.from("profiles").select("id", { count: "exact", head: true }).eq("status", "pending"),
        sb.from("upgrade_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
      ]);
      const n = (p.count || 0) + (u.count || 0);
      const gear = document.getElementById("settings-btn");
      gear.querySelector(".tab-badge")?.remove();
      if (n) gear.insertAdjacentHTML("beforeend", `<span class="tab-badge" style="right:-4px;top:-4px">${n}</span>`);
      gear.style.position = "relative";
    }
  } catch { el.hidden = true; }
}

document.getElementById("brand-logo").innerHTML = icon("radar", 20);
document.getElementById("settings-btn").innerHTML = icon("settings", 18);
document.getElementById("alerts-btn").innerHTML = icon("bell", 18);
document.getElementById("favs-btn").innerHTML = heartIcon.replace('width="20" height="20"', 'width="18" height="18"');
// coração em qualquer tela (fica dentro de cartões-link: não deixa abrir o link)
document.addEventListener("click", (e) => {
  const b = e.target.closest(".fav-btn");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  toggleFav(b);
}, true);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));

sb.auth.onAuthStateChange((event, s) => {
  const was = !!S.session;
  S.session = s;
  if (event === "SIGNED_IN" && !was) { location.hash = "#/"; loadProfile().then(() => loadFavs(true)).then(render); updateBotStatus(); }
  if (event === "SIGNED_OUT") { S.profile = null; S.usage = null; document.getElementById("upgrade-fab")?.remove(); render(); }
});
// erros de limite do plano (vindos do banco) abrem o assistente de upgrade
addEventListener("limit-error", (e) => handleLimitError(e.detail));
addEventListener("usage-changed", () => loadUsage());
window.addEventListener("hashchange", render);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.session) return;
  invalidate();
  loadUsage();
  updateBotStatus();
  if (/^#\/(rotas|rota\/|alertas)|^#\/?$/.test(location.hash || "#/")) render();
});

const { data } = await sb.auth.getSession();
S.session = data.session;
if (S.session) { await loadProfile(); await loadFavs(); }
render();
if (S.session) updateBotStatus();
setInterval(() => S.session && updateBotStatus(), 5 * 60000);
