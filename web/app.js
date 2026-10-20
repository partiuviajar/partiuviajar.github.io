// Radar de Voos: roteador e casca do app (cabeçalho, menu, status do robô).
import { sb, S, q, esc, friendlyError, fmtDateTime } from "./js/core.js";
import { icon } from "./js/icons.js";
import { viewHome } from "./js/views/home.js";
import { viewRoutes, viewRoute, viewForm, viewExplore } from "./js/views/routes.js";
import { viewGuideIndex, viewGuide } from "./js/views/guide.js";
import { viewStay, viewHotels } from "./js/views/stay.js";
import { viewAlerts, viewSettings, viewLogin } from "./js/views/misc.js";

const $view = document.getElementById("view");

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
];

const TABS = [
  ["#/", "Home", "house", (h) => h === "#/" || h === "#"],
  ["#/rotas", "Rotas", "plane", (h) => /^#\/(rota|nova|editar|explorar)/.test(h)],
  ["#/guide", "Guide", "earth", (h) => /^#\/(guide|destino)/.test(h)],
  ["#/hospedagem", "Hospedagem", "bed-double", (h) => /^#\/(hospedagem|hoteis|viagem)/.test(h)],
  ["#/alertas", "Alertas", "bell", (h) => h.startsWith("#/alertas")],
];

function shell(hash, logged) {
  document.getElementById("topbar").hidden = !logged;
  document.getElementById("tabs").hidden = !logged;
  if (!logged) return;
  document.getElementById("tabs-in").innerHTML = TABS.map(([href, label, ic, active]) => {
    const on = active(hash);
    return `<a class="tab pressable ${on ? "active" : ""}" href="${href}"><span class="tab-ic">${icon(ic, 20, "", on ? 2.4 : 2)}</span><span>${label}</span>${label === "Alertas" && S.newAlerts ? `<span class="tab-badge">${S.newAlerts}</span>` : ""}</a>`;
  }).join("");
  document.getElementById("settings-btn").classList.toggle("on", hash.startsWith("#/config"));
}

async function render() {
  const [hash, query = ""] = (location.hash || "#/").split("?");
  S.params = new URLSearchParams(query);
  const logged = !!S.session;
  if (!logged && hash !== "#/login") { location.replace("#/login"); return; }
  if (logged && hash === "#/login") { location.replace("#/"); return; }
  shell(hash, logged);
  const seq = ++S.seq;
  const match = ROUTES.find(([re]) => re.test(hash));
  if (!match) { location.replace("#/"); return; }
  const args = hash.match(match[0]).slice(1);
  try {
    const html = await match[1](...args);
    if (seq !== S.seq) return;
    if (typeof html === "string") $view.innerHTML = html;
    window.scrollTo(0, 0);
    await match[1].after?.(...args);
  } catch (e) {
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
  } catch { el.hidden = true; }
}

document.getElementById("brand-logo").innerHTML = icon("radar", 20);
document.getElementById("settings-btn").innerHTML = icon("settings", 18);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));

sb.auth.onAuthStateChange((event, s) => {
  const was = !!S.session;
  S.session = s;
  if (event === "SIGNED_IN" && !was) { location.hash = "#/"; render(); updateBotStatus(); }
  if (event === "SIGNED_OUT") render();
});
window.addEventListener("hashchange", render);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.session) return;
  updateBotStatus();
  if (/^#\/(rotas|rota\/|alertas)|^#\/?$/.test(location.hash || "#/")) render();
});

const { data } = await sb.auth.getSession();
S.session = data.session;
render();
if (S.session) updateBotStatus();
setInterval(() => S.session && updateBotStatus(), 5 * 60000);
