// Alertas, Ajustes e Login.
import { sb, S, q, esc, brl, ago, fmtShort, fmtDateTime, toast, friendlyError, userName } from "../core.js";
import { VAPID_PUBLIC_KEY } from "../../config.js";
import { icon } from "../icons.js";
import { pill } from "../ui.js";

const rerender = () => dispatchEvent(new HashChangeEvent("hashchange"));

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------
const LEG = { out: "Só ida", back: "Só volta", rt: "Ida e volta", combo: "Duas passagens só de ida" };

export async function viewAlerts() {
  const alerts = await q(sb.from("alerts").select("*, routes(origin,destination,origin_label,destination_label,trip_type)").order("created_at", { ascending: false }).limit(100));
  return `<main class="page">
    <div class="page-title"><h1>Alertas</h1><p>Todos os alertas de preço que o robô enviou para você.</p></div>
    ${!alerts.length ? `<div class="card pad center"><div style="font-size:40px">🔔</div><p class="b">Nenhum alerta ainda</p><p class="sm muted" style="margin-top:4px">Quando um preço cair abaixo do normal, ele aparece aqui e no seu WhatsApp/celular.</p></div>` : ""}
    <div>${alerts.map((a, i) => {
      const r = a.routes;
      const route = r ? `${r.origin_label || r.origin} → ${r.destination_label || r.destination}` : "Rota apagada";
      const leg = a.leg ? LEG[a.leg] : r?.trip_type === "one_way" ? "Só ida" : "Ida e volta";
      const dates = a.return_date ? `${fmtShort(a.depart_date)} → ${fmtShort(a.return_date)}` : fmtShort(a.depart_date);
      const reasons = (a.reasons || []).join("; ");
      const err = /erro de tarifa/i.test(reasons);
      const p = a.normal_price ? Math.round((1 - a.price / a.normal_price) * 100) : null;
      return `<article class="card alert-card fade-up ${err ? "err" : ""}" style="animation-delay:${i * 50}ms;margin-top:${i ? 12 : 0}px">
        <div class="row between" style="align-items:flex-start"><div class="grow"><p class="b truncate">${esc(route)}</p><p class="xs muted">${esc(leg)}${a.direct_only ? " (direto)" : ""} · ${esc(dates)}</p></div><span class="xs muted">${ago(a.created_at)}</span></div>
        <div class="row" style="align-items:flex-end;gap:8px"><span class="price-xl good-t">${brl(a.price)}</span>${a.normal_price ? `<span class="sm muted strike">${brl(a.normal_price)}</span>` : ""}${p ? pill(`-${p}%`, "good", "") : ""}</div>
        <p class="sm" style="font-weight:500;${err ? "color:var(--warn)" : ""}">${err ? "⚠️ " : ""}${esc(reasons)}</p>
        <div class="row wrap" style="gap:6px">
          ${(a.channels || []).map((c) => pill(`${icon(c === "whatsapp" ? "message-circle" : c === "telegram" ? "send" : "smartphone", 12)} ${c === "whatsapp" ? "WhatsApp" : c === "telegram" ? "Telegram" : "App"}`, "primary")).join("") || pill("não enviado")}
          ${a.link ? `<a class="xs sb primary-t" style="margin-left:auto" href="${esc(a.link)}" target="_blank" rel="noopener">abrir oferta ↗</a>` : ""}
        </div>
      </article>`;
    }).join("")}</div>
  </main>`;
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const urlB64 = (b64) => { const p = "=".repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || isIOS ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Navegador";
}
async function currentPushSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function viewSettings() {
  const [s, runs, subs, sub] = await Promise.all([
    q(sb.from("settings").select("*").eq("id", 1).maybeSingle()),
    q(sb.from("bot_runs").select("*").order("started_at", { ascending: false }).limit(6)),
    q(sb.from("push_subscriptions").select("device,created_at")),
    currentPushSub().catch(() => null),
  ]);
  const st = s || {};
  const ch = st.bot_channels || {};
  const hb = st.bot_heartbeat_at;
  const mins = hb ? (Date.now() - new Date(hb)) / 60000 : Infinity;
  const testPending = st.test_requested_at && (!st.test_done_at || st.test_requested_at > st.test_done_at);
  const pushNote = isIOS && !isStandalone ? "No iPhone, primeiro instale o app na tela inicial pelo Safari (Compartilhar → Adicionar à Tela de Início) e abra pelo ícone."
    : !pushSupported ? "Este navegador não suporta notificações. Use o Chrome (Android/computador) ou o app instalado no iPhone."
    : Notification.permission === "denied" ? "As notificações estão bloqueadas para este site. Libere nas configurações do navegador e volte aqui."
    : sub ? "✅ Notificações ativas neste aparelho." : "Receba os alertas de preço na hora, mesmo com o app fechado.";
  const canPush = pushSupported && !(isIOS && !isStandalone) && Notification.permission !== "denied";
  const channel = (ic, label, key, note) => `<div class="channel"><span class="channel-ic">${icon(ic, 20)}</span>
    <div class="grow"><p class="sb">${label}</p>${note ? `<p class="xs muted">${note}</p>` : ""}</div>
    <button type="button" class="switch" role="switch" aria-label="${label}" aria-checked="${st[key] !== false}" data-set="${key}"></button></div>`;
  return `<main class="page">
    <div class="page-title"><h1>Ajustes</h1></div>
    <section class="cta bg-brand shadow-float">${icon("bell", 28)}<h3 style="font-size:20px" class="b">${sub ? "Notificações ativas" : "Ativar notificações neste aparelho"}</h3><p class="sm" style="opacity:.9">${esc(pushNote)}</p>
      ${canPush ? (sub ? `<button class="btn-lime pressable" id="push-off">Desativar neste aparelho</button>` : `<button class="btn-lime pressable" id="push-on">Ativar agora</button>`) : ""}</section>

    <section class="card">
      ${channel("message-circle", "WhatsApp", "notify_whatsapp", ch.whatsapp ? "configurado" : "não configurado")}
      ${channel("smartphone", "Notificação do app", "notify_push", `${subs.length} aparelho${subs.length === 1 ? "" : "s"}`)}
      ${channel("send", "Telegram", "notify_telegram", ch.telegram ? "configurado" : "não configurado")}
      <div class="pad"><button class="btn block pressable" id="test-btn" ${testPending ? "disabled" : ""} style="border-radius:var(--r-xl);padding:12px">${testPending ? "Teste pedido: chega em até ~15 min" : "Enviar notificação de teste"}</button></div>
    </section>

    <section class="card pad">
      <div class="row between" style="margin-bottom:12px"><h3 class="b">Robô</h3>${pill(!hb ? "● parado" : mins < 75 ? "● ativo · a cada 15 min" : mins < 240 ? "● atrasado" : "● parado", mins < 75 ? "good" : mins < 240 ? "warn" : "bad")}</div>
      <ul>${runs.map((r, i) => `<li style="margin-top:${i ? 10 : 0}px"><div class="row sm" style="gap:12px"><span class="dot ${r.status === "ok" || r.status === "running" ? "" : "warn"}"></span><span class="grow truncate">${esc((r.summary || "").split("\n").find((l) => l.trim()) || (r.status === "running" ? "rodando…" : "sem mudanças"))}</span><span class="xs muted">${ago(r.started_at)}</span></div>
        ${r.summary && r.summary.includes("\n") ? `<details><summary class="xs muted" style="margin-left:20px;cursor:pointer">ver detalhes</summary><pre class="log">${esc(r.summary)}</pre></details>` : ""}</li>`).join("") || `<li class="sm muted">Ainda sem execuções registradas.</li>`}</ul>
      <p class="xs muted" style="margin-top:10px">Última execução: ${hb ? `${fmtDateTime(hb)} (${ago(hb)})` : "–"} · Aviasales ${ch.aviasales ? "ativo" : "sem token"}</p>
    </section>

    <section class="card pad stack">
      <h3 class="b row">${icon("radar", 16)} Como quer ser chamado?</h3>
      <div class="row"><input class="input" id="name-input" maxlength="30" placeholder="Seu nome" value="${esc(S.session?.user?.user_metadata?.name || "")}"><button class="btn primary pressable" id="name-save">Salvar</button></div>
      <p class="xs muted">Aparece no “Bem-vindo, ${esc(userName())}!” da Home.</p>
    </section>

    <section class="card pad"><h3 class="b row">${icon("download", 16)} Instalar no celular</h3>
      <ol class="sm muted" style="list-style:decimal;padding-left:20px;margin-top:8px"><li>iPhone: abra no Safari · Android: abra no Chrome</li><li>Toque em Compartilhar (iPhone) ou no menu ⋮ (Android)</li><li>Escolha “Adicionar à Tela de Início” / “Instalar app”</li></ol></section>

    <section class="card pad row between" style="gap:12px"><div class="grow"><p class="xs muted">Conta</p><p class="sb truncate">${esc(S.session?.user?.email)}</p></div>
      <button class="btn danger pressable" id="logout">${icon("log-out", 16)} Sair</button></section>
  </main>`;
}

viewSettings.after = () => {
  document.querySelectorAll("[data-set]").forEach((sw) => sw.addEventListener("click", async () => {
    const on = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(on));
    try { await q(sb.from("settings").update({ [sw.dataset.set]: on }).eq("id", 1)); toast("Salvo"); }
    catch (err) { sw.setAttribute("aria-checked", String(!on)); toast(friendlyError(err)); }
  }));
  document.getElementById("test-btn")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { await q(sb.from("settings").update({ test_requested_at: new Date().toISOString() }).eq("id", 1)); e.currentTarget.textContent = "Teste pedido: chega em até ~15 min"; toast("🔔 Teste pedido! O robô envia na próxima rodada."); }
    catch (err) { e.currentTarget.disabled = false; toast(friendlyError(err)); }
  });
  document.getElementById("push-on")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Você não permitiu as notificações.");
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      await q(sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName() }));
      toast("✅ Notificações ativadas! Use “Enviar notificação de teste” para conferir.", 4500);
      rerender();
    } catch (err) { e.currentTarget.disabled = false; toast(friendlyError(err), 5000); }
  });
  document.getElementById("push-off")?.addEventListener("click", async () => {
    const sub = await currentPushSub();
    if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
    toast("Notificações desativadas neste aparelho."); rerender();
  });
  document.getElementById("name-save")?.addEventListener("click", async () => {
    const name = document.getElementById("name-input").value.trim();
    try {
      const { data, error } = await sb.auth.updateUser({ data: { name } });
      if (error) throw error;
      if (data?.user && S.session) S.session.user = data.user;
      toast("✅ Nome salvo");
    } catch (err) { toast(friendlyError(err)); }
  });
  document.getElementById("logout").addEventListener("click", async () => { await sb.auth.signOut(); toast("Você saiu"); location.hash = "#/login"; });
};

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
export function viewLogin() {
  return `<main class="login">
    <div class="center"><span class="brand-logo bg-brand shadow-float" style="width:64px;height:64px;margin:0 auto;border-radius:var(--r-2xl)">${icon("radar", 32)}</span>
      <h1 class="display xb" style="font-size:30px;margin-top:16px">Radar de Voos</h1>
      <p class="sm muted">Vigia preços de passagens 24 h e avisa quando ficam abaixo do normal.</p></div>
    <form class="card pad stack" id="login-form">
      <div class="seg" id="login-mode"><button type="button" class="on" data-m="in">Entrar</button><button type="button" data-m="up">Criar conta</button></div>
      <label class="field"><span>E-mail</span><input class="input" type="email" name="email" autocomplete="email" required></label>
      <label class="field"><span>Senha</span><input class="input" type="password" name="password" autocomplete="current-password" minlength="6" required></label>
      <button class="btn big block bg-brand shadow-float pressable" type="submit" style="font-size:16px">Entrar</button>
      <div id="login-msg"></div>
    </form>
  </main>`;
}
viewLogin.after = () => {
  let mode = "in";
  const form = document.getElementById("login-form");
  const f = (n) => form.elements.namedItem(n);
  const msg = document.getElementById("login-msg");
  document.getElementById("login-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.m;
    form.querySelectorAll("#login-mode button").forEach((x) => x.classList.toggle("on", x === b));
    form.querySelector("[type=submit]").textContent = mode === "in" ? "Entrar" : "Criar conta";
    f("password").autocomplete = mode === "in" ? "current-password" : "new-password";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true; msg.innerHTML = "";
    const email = f("email").value.trim(), password = f("password").value;
    try {
      if (mode === "in") await q(sb.auth.signInWithPassword({ email, password }));
      else {
        const data = await q(sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
        if (!data.session) msg.innerHTML = `<div class="hint">Conta criada! Abra o e-mail de confirmação e depois entre aqui.</div>`;
      }
    } catch (err) { msg.innerHTML = `<div class="hint bad">${esc(friendlyError(err))}</div>`; }
    finally { btn.disabled = false; }
  });
};
