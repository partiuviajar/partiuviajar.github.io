// Planos, limites, cadeados, assistente "Fazer upgrade", página de Planos e Painel do administrador.
import { sb, S, q, esc, ago, toast, friendlyError, invalidate } from "./core.js";
import { icon } from "./icons.js";
import { pill, seg, bindSeg } from "./ui.js";

export const PLANS = {
  basic:  { key: "basic",  name: "Viajante Iniciante",  emoji: "🎒", price: "Grátis",       routes: 2,  copilotMonth: 1,  copilotWeek: null, guideFavs: 3,    minInterval: 3, whatsapp: false },
  silver: { key: "silver", name: "Viajante Apaixonado", emoji: "✈️", price: "R$ 19,90/mês", routes: 5,  copilotMonth: 4,  copilotWeek: 1,    guideFavs: null, minInterval: 3, whatsapp: true },
  gold:   { key: "gold",   name: "Mochileiro Pro",      emoji: "🌍", price: "R$ 39,90/mês", routes: 10, copilotMonth: 10, copilotWeek: null, guideFavs: null, minInterval: 1, whatsapp: true },
};
const ORDER = ["basic", "silver", "gold"];

// ---------------------------------------------------------------------------
// Perfil e uso de quem está logado
// ---------------------------------------------------------------------------
export async function loadProfile() {
  try {
    const p = await q(sb.from("profiles").select("*").eq("id", S.session.user.id).maybeSingle());
    // sem perfil ainda (o comando do Supabase não foi rodado): modo antigo, tudo liberado
    S.profile = p || { role: "admin", status: "active", plan: "gold", legacy: true };
  } catch { S.profile = { role: "admin", status: "active", plan: "gold", legacy: true }; }
  if (!S.profile.legacy) sb.rpc("touch_last_seen").then(() => {}, () => {});
  await loadUsage();
  return S.profile;
}
export async function loadUsage() {
  if (S.profile?.legacy) { S.usage = { routes_active: 0, copilot_month: 0, copilot_week: 0, guide_favs: 0 }; return S.usage; }
  try { S.usage = (await sb.rpc("my_usage")).data || {}; } catch { S.usage = {}; }
  return S.usage;
}
export const isAdmin = () => S.profile?.role === "admin";
export const planKey = () => (isAdmin() ? "gold" : S.profile?.plan || "basic");
export const myPlan = () => PLANS[planKey()];
// o plano mais barato que libera algo
export function planFor(test) { return ORDER.map((k) => PLANS[k]).find(test) || PLANS.gold; }

export const lockTag = (plan) => `<span class="lock-tag">🔒 ${esc(plan.name)}</span>`;

// limites atuais (para contadores e cadeados)
export function limits() {
  const p = myPlan(), u = S.usage || {};
  return {
    plan: p,
    routesLeft: p.routes - (u.routes_active || 0),
    copilotLeft: Math.min(p.copilotMonth - (u.copilot_month || 0), p.copilotWeek ? p.copilotWeek - (u.copilot_week || 0) : Infinity),
    favsLeft: p.guideFavs == null ? Infinity : p.guideFavs - (u.guide_favs || 0),
  };
}

// erro de limite vindo do banco → mensagem clara + abre o assistente
export function handleLimitError(err) {
  const m = String(err?.message || err);
  const hit = m.match(/LIMITE_(ROTAS|INTERVALO|FAVORITOS|COPILOTO_MES|COPILOTO_SEMANA):(\w+):(\d+)/);
  if (!hit) return false;
  const [, kind, plan, n] = hit;
  const name = PLANS[plan]?.name || plan;
  const text = {
    ROTAS: `Seu plano ${name} permite ${n} rotas ativas.`,
    INTERVALO: `No plano ${name} a verificação mínima é a cada ${n} h.`,
    FAVORITOS: `Seu plano ${name} permite ${n} guias favoritos.`,
    COPILOTO_MES: `Seu plano ${name} permite ${n} consulta${n > 1 ? "s" : ""} do Copiloto por mês.`,
    COPILOTO_SEMANA: `Seu plano ${name} permite ${n} consulta do Copiloto por semana.`,
  }[kind];
  openUpgrade(text);
  return true;
}

// ---------------------------------------------------------------------------
// Assistente "Fazer upgrade" (botão flutuante + conversa)
// ---------------------------------------------------------------------------
export function upgradeFab() {
  if (!S.profile || S.profile.legacy || isAdmin() || planKey() === "gold" || S.profile.status !== "active") return "";
  return `<button type="button" class="upgrade-fab glass pressable" id="upgrade-fab">${icon("sparkles", 18)} Fazer upgrade</button>`;
}

export async function openUpgrade(reason = "", target = null) {
  document.getElementById("assistant")?.remove();
  const name = (S.session?.user?.user_metadata?.name || S.profile?.name || "").split(" ")[0] || "viajante";
  const cur = planKey();
  const above = ORDER.slice(ORDER.indexOf(cur) + 1);
  let pending = null;
  try { pending = (await q(sb.from("upgrade_requests").select("to_plan,created_at").eq("status", "pending").order("created_at", { ascending: false }).limit(1)))[0]; } catch {}
  const el = document.createElement("div");
  el.id = "assistant";
  el.className = "assistant-wrap";
  el.innerHTML = `<div class="assistant card fade-up" role="dialog" aria-label="Fazer upgrade">
    <div class="row between assistant-head"><div class="row" style="gap:10px"><span class="assistant-av">✨</span><div><b>Assistente Partiu Viajar</b><p class="tiny muted">responde na hora</p></div></div>
      <button type="button" class="round-btn" id="as-close" aria-label="Fechar">${icon("x", 18)}</button></div>
    <div class="assistant-body" id="as-body"></div>
  </div>`;
  document.body.appendChild(el);
  const body = el.querySelector("#as-body");
  const say = (html, who = "bot") => { body.insertAdjacentHTML("beforeend", `<div class="bubble ${who} fade-up">${html}</div>`); body.scrollTop = body.scrollHeight; };
  const close = () => el.remove();
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  el.querySelector("#as-close").addEventListener("click", close);

  say(`Oi, ${esc(name)}! 👋 ${reason ? `${esc(reason)} ` : ""}Hoje você está no plano <b>${PLANS[cur].emoji} ${PLANS[cur].name}</b>.`);
  if (pending) {
    say(`Você já pediu o plano <b>${PLANS[pending.to_plan]?.name}</b> ${ago(pending.created_at)}. Assim que for liberado, seu plano muda aqui no app. 🙌`);
    return;
  }
  if (!above.length) { say("Você já está no plano mais completo. Aproveite! 🌍"); return; }
  setTimeout(() => {
    say(`Olha a diferença entre os planos:<div class="as-plans">${ORDER.map((k) => planMini(PLANS[k], k === cur)).join("")}</div>`);
    setTimeout(() => {
      say(`Qual plano você gostaria?<div class="as-choices">${above.map((k) => `<button type="button" class="btn ${k === "gold" ? "primary" : ""} pressable" data-plan="${k}">${PLANS[k].emoji} ${PLANS[k].name} · ${PLANS[k].price}</button>`).join("")}</div>`);
      body.querySelectorAll("[data-plan]").forEach((b) => b.addEventListener("click", () => choose(b.dataset.plan)));
      if (target && above.includes(target)) choose(target);
    }, 350);
  }, 350);

  let chosen = false;
  function choose(k) {
    if (chosen) return;
    chosen = true;
    body.querySelectorAll("[data-plan]").forEach((x) => (x.disabled = true));
    say(`Quero o ${PLANS[k].emoji} ${PLANS[k].name}`, "me");
    setTimeout(() => {
      say(`Ótima escolha! Quer deixar um recado? (opcional)
        <textarea class="input" id="as-msg" rows="2" maxlength="300" placeholder="Ex.: quero testar o Copiloto mais vezes"></textarea>
        <button type="button" class="btn big block bg-brand shadow-float pressable" id="as-send" style="margin-top:8px;font-size:15px">${icon("send", 18)} Enviar pedido</button>`);
      el.querySelector("#as-send").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = "⏳ Enviando…";
        try {
          await q(sb.from("upgrade_requests").insert({ to_plan: k, from_plan: cur, email: S.session.user.email, name: S.session.user.user_metadata?.name || S.profile?.name || null, message: el.querySelector("#as-msg").value.trim() || null }));
          btn.remove();
          say(`Pronto! 🙌 Seu pedido do <b>${PLANS[k].name}</b> foi enviado. Assim que for liberado, seu plano muda aqui no app.`);
        } catch (err) { btn.disabled = false; btn.textContent = "Enviar pedido"; say(`Não consegui enviar agora: ${esc(friendlyError(err))}`); }
      });
    }, 300);
  }
}

function planMini(p, current) {
  return `<div class="as-plan ${current ? "on" : ""}"><b>${p.emoji} ${p.name}</b><span class="tiny muted">${p.price}</span>
    <ul class="tiny"><li>${p.routes} rotas</li><li>Copiloto ${p.copilotWeek ? `${p.copilotWeek}x/semana` : `${p.copilotMonth}x/mês`}</li><li>${p.guideFavs ? `${p.guideFavs} guias favoritos` : "guias ilimitados"}</li><li>${p.whatsapp ? "avisos no WhatsApp" : "avisos no app"}</li><li>robô a cada ${p.minInterval} h</li></ul></div>`;
}

// ---------------------------------------------------------------------------
// Página de Planos
// ---------------------------------------------------------------------------
export async function viewPlans() {
  await loadUsage();
  const cur = planKey();
  const feat = (ok, text) => `<li class="${ok ? "" : "off"}">${ok ? "✅" : "🔒"} ${text}</li>`;
  return `<main class="page">
    <div class="page-title"><h1>Planos</h1><p>Escolha como quer viajar. Você está no <b>${PLANS[cur].emoji} ${PLANS[cur].name}</b>.</p></div>
    ${ORDER.map((k, i) => {
      const p = PLANS[k], on = k === cur, up = ORDER.indexOf(k) > ORDER.indexOf(cur);
      return `<article class="card plan-card ${k} ${on ? "current" : ""} fade-up" style="animation-delay:${i * 80}ms;margin-top:${i ? 14 : 0}px">
        <div class="row between"><h2 class="display xb" style="font-size:22px">${p.emoji} ${p.name}</h2>${on ? pill("seu plano", "good") : k === "gold" ? pill("mais completo", "lime") : ""}</div>
        <p class="price-xl">${p.price}</p>
        <ul class="plan-feats">
          ${feat(true, `<b>${p.routes}</b> rotas vigiadas ao mesmo tempo`)}
          ${feat(true, `Copiloto ✨ <b>${p.copilotWeek ? `${p.copilotWeek}x por semana` : `${p.copilotMonth}x por mês`}</b>`)}
          ${feat(true, p.guideFavs ? `Até <b>${p.guideFavs}</b> guias favoritos` : "Guias favoritos <b>ilimitados</b>")}
          ${feat(true, `Robô verifica a cada <b>${p.minInterval} h</b>`)}
          ${feat(true, "Notificação do app no celular")}
          ${feat(p.whatsapp, "Alertas no WhatsApp")}
          ${feat(true, "Guide, hotéis e passeios")}
        </ul>
        ${up ? `<button type="button" class="btn block ${k === "gold" ? "bg-brand shadow-float" : "primary"} pressable" data-want="${k}" style="margin-top:12px">Quero o ${p.name}</button>` : ""}
      </article>`;
    }).join("")}
    <p class="xs muted center" style="padding-top:6px">Por enquanto a liberação é manual: você pede aqui e o administrador libera.</p>
  </main>`;
}
viewPlans.after = () => document.querySelectorAll("[data-want]").forEach((b) => b.addEventListener("click", () => openUpgrade("", b.dataset.want)));

// ---------------------------------------------------------------------------
// Tela de espera (conta nova ainda não aprovada / bloqueada)
// ---------------------------------------------------------------------------
export function gateScreen() {
  const blocked = S.profile?.status === "blocked";
  return `<main class="page"><section class="card prep">
    <div style="font-size:48px">${blocked ? "🚫" : "⏳"}</div>
    <h1 class="display xb" style="font-size:26px">${blocked ? "Conta bloqueada" : "Conta criada! 🎉"}</h1>
    <p class="sm muted" style="margin:8px 0 16px">${blocked ? "Fale com o administrador do Partiu Viajar para entender o motivo." : "Agora é só esperar a aprovação. Você recebe acesso assim que o administrador liberar sua conta."}</p>
    <div class="row" style="gap:8px;justify-content:center"><button class="btn primary pressable" onclick="location.reload()">${icon("refresh-cw", 16)} Atualizar</button>
    <button class="btn pressable" id="gate-out">${icon("log-out", 16)} Sair</button></div>
  </section></main>`;
}

// ---------------------------------------------------------------------------
// Painel do administrador
// ---------------------------------------------------------------------------
let adminTab = "pedidos", adminSearch = "";

export async function viewAdmin() {
  if (!isAdmin()) return `<main class="page"><div class="card pad">Área restrita.</div></main>`;
  const [users, ups] = await Promise.all([
    q(sb.rpc("admin_users")),
    q(sb.from("upgrade_requests").select("*").eq("status", "pending").order("created_at")),
  ]);
  S.current = { users, ups };
  const pendingUsers = users.filter((u) => u.status === "pending");
  return `<main class="page">
    <div class="page-title"><h1>Administração</h1><p>Contas, planos e pedidos de upgrade.</p></div>
    ${seg("adm-tabs", [["pedidos", `Pedidos <span class="muted">${pendingUsers.length + ups.length}</span>`], ["contas", `Contas <span class="muted">${users.length}</span>`], ["numeros", "Números"]], adminTab)}
    <div id="adm-body"></div>
  </main>`;
}
viewAdmin.after = () => {
  if (!S.current?.users) return;
  bindSeg("adm-tabs", (v) => { adminTab = v; draw(); });
  draw();
};

const planSelect = (u) => `<select class="input sm-select" data-plan-of="${u.id}">${ORDER.map((k) => `<option value="${k}" ${u.plan === k ? "selected" : ""}>${PLANS[k].emoji} ${PLANS[k].name}</option>`).join("")}</select>`;

function draw() {
  const { users, ups } = S.current;
  const el = document.getElementById("adm-body");
  if (!el) return;
  const pendingUsers = users.filter((u) => u.status === "pending");
  if (adminTab === "pedidos") {
    el.innerHTML = `
      <h2 class="sec-h">👤 Cadastros esperando aprovação</h2>
      ${pendingUsers.length ? pendingUsers.map((u) => `<div class="card pad-s adm-row" data-user="${u.id}">
        <div class="grow"><p class="b truncate">${esc(u.name || "Sem nome")}</p><p class="xs muted truncate">${esc(u.email)} · ${ago(u.created_at)}</p></div>
        <div class="adm-actions">${planSelect(u)}<button class="btn primary sm pressable" data-approve="${u.id}">Aprovar</button><button class="btn danger sm pressable" data-block="${u.id}">Recusar</button></div>
      </div>`).join("") : `<p class="sm muted">Nenhum cadastro novo.</p>`}
      <h2 class="sec-h">⬆️ Pedidos de upgrade</h2>
      ${ups.length ? ups.map((r) => `<div class="card pad-s adm-row">
        <div class="grow"><p class="b truncate">${esc(r.name || r.email)}</p><p class="xs muted">${PLANS[r.from_plan]?.name || r.from_plan} → <b>${PLANS[r.to_plan]?.emoji} ${PLANS[r.to_plan]?.name}</b> · ${ago(r.created_at)}</p>${r.message ? `<p class="xs">💬 ${esc(r.message)}</p>` : ""}</div>
        <div class="adm-actions"><button class="btn primary sm pressable" data-up-ok="${r.id}">Liberar</button><button class="btn danger sm pressable" data-up-no="${r.id}">Recusar</button></div>
      </div>`).join("") : `<p class="sm muted">Nenhum pedido de upgrade.</p>`}`;
  } else if (adminTab === "contas") {
    const term = adminSearch.toLowerCase();
    const list = users.filter((u) => !term || `${u.name} ${u.email}`.toLowerCase().includes(term));
    el.innerHTML = `<div class="search" style="margin-bottom:12px">${icon("search", 20)}<input id="adm-search" type="search" placeholder="Buscar por nome ou e-mail" value="${esc(adminSearch)}"></div>
      ${list.map((u) => {
        const p = PLANS[u.role === "admin" ? "gold" : u.plan];
        return `<div class="card pad-s adm-row" style="margin-top:10px">
          <div class="grow"><p class="b truncate">${esc(u.name || "Sem nome")} ${u.role === "admin" ? pill("admin", "primary") : ""} ${u.status !== "active" ? pill(u.status === "pending" ? "aguardando" : "bloqueada", u.status === "pending" ? "warn" : "bad") : ""}</p>
            <p class="xs muted truncate">${esc(u.email)}</p>
            <p class="tiny muted">rotas ${u.routes_active}/${p.routes} · copiloto ${u.copilot_month}/${p.copilotMonth} no mês · guias ❤️ ${u.guide_favs}${p.guideFavs ? `/${p.guideFavs}` : ""} · visto ${ago(u.last_seen_at)}</p></div>
          ${u.role === "admin" ? "" : `<div class="adm-actions">${planSelect(u)}
            ${u.status === "active" ? `<button class="btn sm pressable" data-block="${u.id}">Bloquear</button>` : `<button class="btn primary sm pressable" data-approve="${u.id}">${u.status === "pending" ? "Aprovar" : "Desbloquear"}</button>`}
            <button class="btn danger sm pressable" data-del="${u.id}">Remover</button></div>`}
        </div>`;
      }).join("") || `<p class="sm muted">Ninguém encontrado.</p>`}`;
    const s = document.getElementById("adm-search");
    s.addEventListener("input", () => { adminSearch = s.value; const pos = s.selectionStart; draw(); const n = document.getElementById("adm-search"); n.focus(); n.setSelectionRange(pos, pos); });
  } else {
    const count = (f) => users.filter(f).length;
    const tile = (k, v) => `<div class="card info-tile"><p class="k">${k}</p><p class="display xb" style="font-size:28px">${v}</p></div>`;
    el.innerHTML = `<div class="grid2">
      ${tile("Contas ativas", count((u) => u.status === "active"))}
      ${tile("Aguardando", count((u) => u.status === "pending"))}
      ${ORDER.map((k) => tile(`${PLANS[k].emoji} ${PLANS[k].name}`, count((u) => u.status === "active" && u.role !== "admin" && u.plan === k))).join("")}
      ${tile("Rotas ativas", users.reduce((a, u) => a + u.routes_active, 0))}
      ${tile("Copiloto no mês", users.reduce((a, u) => a + u.copilot_month, 0))}
    </div>`;
  }
  bindActions();
}

function bindActions() {
  const refresh = async (msg) => { toast(msg); invalidate(); dispatchEvent(new HashChangeEvent("hashchange")); };
  const planOf = (id) => document.querySelector(`[data-plan-of="${id}"]`)?.value;
  const run = (sel, fn) => document.querySelectorAll(sel).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { await fn(b); } catch (err) { b.disabled = false; toast(friendlyError(err)); }
  }));
  run("[data-approve]", async (b) => { const id = b.dataset.approve; await q(sb.from("profiles").update({ status: "active", plan: planOf(id) || "basic" }).eq("id", id)); await refresh("✅ Conta liberada"); });
  run("[data-block]", async (b) => { await q(sb.from("profiles").update({ status: "blocked" }).eq("id", b.dataset.block)); await refresh("Conta bloqueada"); });
  run("[data-del]", async (b) => {
    if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.disabled = false; b.textContent = "Toque de novo"; return; }
    await q(sb.rpc("admin_delete_user", { uid: b.dataset.del })); await refresh("Conta removida");
  });
  document.querySelectorAll("[data-plan-of]").forEach((s) => s.addEventListener("change", async () => {
    const u = S.current.users.find((x) => x.id === s.dataset.planOf);
    if (u?.status !== "active") return; // em pendentes o plano vai junto com o "Aprovar"
    try { await q(sb.from("profiles").update({ plan: s.value }).eq("id", s.dataset.planOf)); toast(`✅ Plano alterado para ${PLANS[s.value].name}`); u.plan = s.value; }
    catch (err) { toast(friendlyError(err)); }
  }));
  run("[data-up-ok]", async (b) => {
    const r = S.current.ups.find((x) => String(x.id) === b.dataset.upOk);
    await q(sb.from("profiles").update({ plan: r.to_plan }).eq("id", r.user_id));
    await q(sb.from("upgrade_requests").update({ status: "approved", handled_at: new Date().toISOString() }).eq("id", r.id));
    await refresh(`✅ ${r.name || r.email} agora é ${PLANS[r.to_plan].name}`);
  });
  run("[data-up-no]", async (b) => { await q(sb.from("upgrade_requests").update({ status: "denied", handled_at: new Date().toISOString() }).eq("id", b.dataset.upNo)); await refresh("Pedido recusado"); });
}
