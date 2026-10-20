// Copiloto ✨: apresentação, questionário passo a passo e as 2 viagens sugeridas.
// O robô busca preços reais (passagens, hotéis, clima) e a IA (Gemini) escolhe e escreve.
import { sb, S, q, esc, brl, ago, fmtShort, todayIso, addDays, daysBetween, toast, friendlyError, flag, photo, bg, loadDestinations, favBtn } from "../core.js";
import { icon } from "../icons.js";
import { pill, back } from "../ui.js";

// ---------------------------------------------------------------------------
// Apresentação
// ---------------------------------------------------------------------------
export async function viewCopilot() {
  const recent = await q(sb.from("copilot_requests").select("id,created_at,status,answers,result").order("created_at", { ascending: false }).limit(5)).catch(() => []);
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const usedThisMonth = recent.filter((r) => new Date(r.created_at) >= month).length;
  return `<main class="page">
    <section class="cop-hero bg-brand shadow-float">
      <div class="cop-art" aria-hidden="true"><span>🧳</span><span>✈️</span><span>🏝️</span><span>💰</span><span>✨</span></div>
      <p class="pill lime" style="width:max-content">✨ Novo</p>
      <h1 class="display xb" style="font-size:36px;line-height:1.05;margin-top:10px">Copiloto</h1>
      <p style="opacity:.92;margin-top:6px">Diga quanto quer gastar e do que você gosta. A gente encontra <b>2 viagens que cabem no seu bolso</b>, com roteiro e custos.</p>
    </section>

    <div class="cop-steps">
      ${step("💰📅", "1. Conte seu plano", "Orçamento, quem vai, quando, clima, praia e o que você curte.")}
      ${step("🔎✈️🏨", "2. O robô pesquisa", "Passagens, hotéis e o clima de verdade nas suas datas, em dezenas de destinos.")}
      ${step("✨🗺️", "3. Duas viagens sob medida", "A IA escolhe as que mais combinam e monta roteiro, custos e dicas.")}
    </div>

    <a class="btn big block bg-brand shadow-float pressable" href="#/copiloto/novo" style="font-size:17px">${icon("sparkles", 22)} Descobrir a viagem que cabe no meu bolso</a>
    <p class="xs muted center">Fica pronto em poucos minutos e avisamos por notificação.${usedThisMonth ? ` Você fez ${usedThisMonth} consulta${usedThisMonth > 1 ? "s" : ""} este mês.` : ""}</p>

    ${recent.length ? `<div class="sec-title"><h2>Suas consultas</h2></div>
      <div>${recent.map((r, i) => {
        const opts = r.result?.options || [];
        return `<a class="card pad-s row pressable" style="gap:12px;margin-top:${i ? 10 : 0}px" href="#/copiloto/${r.id}">
          <span class="emoji-tile">✨</span>
          <span class="grow"><p class="b truncate">${opts.length ? esc(opts.map((o) => o.city).join(" ou ")) : r.status === "error" ? "Não deu certo" : r.result?.empty ? "Nada coube no orçamento" : "Preparando…"}</p>
          <p class="xs muted truncate">${brl(r.answers?.budget)} · ${r.answers?.adults || 1} pessoa${(r.answers?.adults || 1) > 1 ? "s" : ""} · ${ago(r.created_at)}</p></span>
          ${pill(r.status === "done" ? "pronta" : r.status === "error" ? "falhou" : "buscando…", r.status === "done" ? "good" : r.status === "error" ? "bad" : "primary")}
        </a>`;
      }).join("")}</div>` : ""}

    <p class="tiny muted center" style="padding-top:4px">Preços de passagem e hotel são reais (Travelpayouts e Google Hotels). Comida, transporte e passeios são estimativas da IA (Google Gemini, que pode usar o que é enviado para melhorar os modelos).</p>
  </main>`;
}
const step = (emoji, title, text) => `<div class="card cop-step"><span class="cop-step-e">${emoji}</span><div><p class="b">${title}</p><p class="sm muted">${text}</p></div></div>`;

// ---------------------------------------------------------------------------
// Questionário (uma pergunta por tela; algumas aparecem conforme as respostas)
// ---------------------------------------------------------------------------
let A = null;   // respostas
let at = 0;     // passo atual

const STEPS = [
  { id: "budget", title: "Quanto você quer gastar no total?", sub: "Inclui passagens, hospedagem, comida e passeios, para todo mundo." },
  { id: "people", title: "Quem vai?" },
  { id: "dates", title: "Quando você pode viajar?", sub: "Uma janela de datas: a gente acha os dias mais baratos dentro dela." },
  { id: "climate", title: "Que clima você quer?" },
  { id: "snow", title: "Quer ver neve? ❄️", when: () => A.climate === "cold" },
  { id: "beach", title: "Praia faz parte do plano?" },
  { id: "beach_vibe", title: "Que tipo de praia?", when: () => A.beach === "yes" },
  { id: "scope", title: "Brasil ou exterior?" },
  { id: "passport", title: "Você tem passaporte válido?", when: () => A.scope !== "national" },
  { id: "us_visa", title: "Tem visto americano?", sub: "Abre opções nos EUA e no Canadá.", when: () => A.scope !== "national" && A.passport },
  { id: "interests", title: "O que você curte numa viagem?", sub: "Pode marcar vários." },
  { id: "pace", title: "Qual o ritmo da viagem?" },
  { id: "review", title: "Tudo certo?" },
];
const visible = () => STEPS.filter((s) => !s.when || s.when());

const choice = (key, options, multi = false) => `<div class="cop-choices ${options.length > 4 ? "many" : ""}">${options.map(([v, e, l]) => {
  const on = multi ? (A[key] || []).includes(v) : A[key] === v;
  return `<button type="button" class="cop-choice pressable ${on ? "on" : ""}" data-k="${key}" data-v="${esc(String(v))}" ${multi ? "data-multi" : ""}><span class="e">${e}</span><span>${l}</span></button>`;
}).join("")}</div>`;

const stepper = (key, label, min, max) => `<div class="row between card pad-s"><span class="sb">${label}</span>
  <div class="stepper"><button type="button" data-st="${key}" data-d="-1" aria-label="Menos">${icon("minus", 18)}</button><output>${A[key]}</output><button type="button" class="plus" data-st="${key}" data-d="1" data-min="${min}" data-max="${max}" aria-label="Mais">${icon("plus", 18)}</button></div></div>`;

function stepBody(s) {
  switch (s.id) {
    case "budget": return `<div class="cop-money"><span>R$</span><input id="budget" inputmode="numeric" placeholder="10.000" value="${A.budget ? Number(A.budget).toLocaleString("pt-BR") : ""}"></div>
      <div class="row wrap" style="gap:8px;justify-content:center">${[3000, 5000, 8000, 10000, 15000, 25000].map((v) => `<button type="button" class="pill ${A.budget === v ? "primary" : "plain"} pressable" data-budget="${v}" style="padding:8px 14px;font-size:14px;box-shadow:var(--shadow-sm)">${brl(v)}</button>`).join("")}</div>`;
    case "people": return `<div class="stack">${stepper("adults", "Adultos", 1, 9)}${stepper("children", "Crianças", 0, 6)}</div>`;
    case "dates": return `<div class="stack">
      <div class="grid2" style="gap:8px"><label class="field"><span>A partir de</span><input class="input" type="date" id="d-from" min="${addDays(todayIso(), 3)}" value="${A.date_from}"></label>
        <label class="field"><span>Até</span><input class="input" type="date" id="d-to" min="${addDays(todayIso(), 4)}" value="${A.date_to}"></label></div>
      <div class="grid2" style="gap:8px"><label class="field"><span>Viagem de no mínimo (dias)</span><input class="input" type="number" id="d-min" min="2" max="30" inputmode="numeric" value="${A.min_days}"></label>
        <label class="field"><span>No máximo (dias)</span><input class="input" type="number" id="d-max" min="2" max="30" inputmode="numeric" value="${A.max_days}"></label></div>
      <p class="xs muted">Saindo do Rio de Janeiro.</p></div>`;
    case "climate": return choice("climate", [["hot", "☀️", "Calor"], ["mild", "🌤️", "Ameno"], ["cold", "❄️", "Frio"], ["any", "🤷", "Tanto faz"]]);
    case "snow": return choice("snow", [[true, "⛄", "Sim, quero neve!"], [false, "🧥", "Só frio já tá bom"]]);
    case "beach": return choice("beach", [["yes", "🏖️", "Sim!"], ["no", "🏔️", "Não"], ["any", "🤷", "Tanto faz"]]);
    case "beach_vibe": return choice("beach_vibe", [["calm", "🌴", "Sossego"], ["party", "🎉", "Agito"]]);
    case "scope": return choice("scope", [["national", "🇧🇷", "Brasil"], ["international", "🌎", "Exterior"], ["any", "🤷", "Tanto faz"]]);
    case "passport": return choice("passport", [[true, "🛂", "Tenho"], [false, "🪪", "Só RG"]]) + `<p class="xs muted center" style="margin-top:10px">Só com RG dá para ir a vários países da América do Sul.</p>`;
    case "us_visa": return choice("us_visa", [[true, "🇺🇸", "Tenho"], [false, "🚫", "Não tenho"]]);
    case "interests": return choice("interests", [["comida", "🍽️", "Comida"], ["cultura", "🏛️", "Cultura e história"], ["natureza", "🌿", "Natureza"], ["noite", "🎉", "Vida noturna"], ["compras", "🛍️", "Compras"], ["descanso", "🧘", "Descanso"], ["aventura", "🏄", "Aventura"]], true);
    case "pace": return `${choice("pace", [["slow", "🐢", "Tranquilo"], ["fast", "⚡", "Ver muita coisa"]])}
      <label class="field" style="margin-top:14px"><span>Algo mais que a gente deveria saber? (opcional)</span><textarea class="input" id="notes" rows="3" maxlength="300" placeholder="Ex.: lua de mel, vou com criança pequena, não gosto de lugar muito cheio…">${esc(A.notes || "")}</textarea></label>`;
    case "review": {
      const L = { hot: "Calor", mild: "Ameno", cold: "Frio", any: "Tanto faz", yes: "Sim", no: "Não", calm: "sossego", party: "agito", national: "Brasil", international: "Exterior", slow: "Tranquilo", fast: "Intenso" };
      const row = (k, v) => `<div class="list-row"><span class="sm muted">${k}</span><b class="sm" style="text-align:right">${v}</b></div>`;
      return `<div class="card pad">
        ${row("Orçamento total", brl(A.budget))}
        ${row("Quem vai", `${A.adults} adulto${A.adults > 1 ? "s" : ""}${A.children ? ` + ${A.children} criança${A.children > 1 ? "s" : ""}` : ""}`)}
        ${row("Quando", `${fmtShort(A.date_from)} a ${fmtShort(A.date_to)} · ${A.min_days} a ${A.max_days} dias`)}
        ${row("Clima", `${L[A.climate]}${A.climate === "cold" && A.snow ? " com neve" : ""}`)}
        ${row("Praia", `${L[A.beach]}${A.beach === "yes" ? ` (${L[A.beach_vibe]})` : ""}`)}
        ${row("Destino", `${L[A.scope]}${A.scope !== "national" ? ` · ${A.passport ? "com passaporte" : "só RG"}${A.passport && A.us_visa ? " e visto americano" : ""}` : ""}`)}
        ${row("Curte", (A.interests || []).join(", ") || "–")}
        ${row("Ritmo", L[A.pace])}
      </div>`;
    }
  }
  return "";
}

export function viewCopilotForm() {
  const start = addDays(todayIso(), 30);
  A = A || { budget: null, adults: 2, children: 0, date_from: start, date_to: addDays(start, 60), min_days: 5, max_days: 10, climate: null, snow: false, beach: null, beach_vibe: "calm", scope: "any", passport: true, us_visa: false, interests: [], pace: "slow", notes: "", origin: "RIO" };
  at = Math.min(at, visible().length - 1);
  return `<main class="page" id="cop-form">${formInner()}</main>`;
}

function formInner() {
  const steps = visible();
  const s = steps[at];
  return `<div class="row between">${at === 0 ? back("#/copiloto", "Copiloto") : `<button type="button" class="back" id="cop-prev">${icon("arrow-left", 16)} Voltar</button>`}<span class="xs sb muted">${at + 1} de ${steps.length}</span></div>
    <div class="progress"><i style="width:${((at + 1) / steps.length) * 100}%"></i></div>
    <div class="cop-q fade-up"><h1 class="display xb" style="font-size:28px;line-height:1.15">${s.title}</h1>${s.sub ? `<p class="sm muted" style="margin-top:4px">${s.sub}</p>` : ""}</div>
    <div class="fade-up" style="animation-delay:60ms">${stepBody(s)}</div>
    <div id="cop-msg"></div>
    ${s.id === "review" ? `<button type="button" class="btn big block bg-brand shadow-float pressable" id="cop-send" style="font-size:17px">${icon("sparkles", 22)} Gerar minhas 2 viagens</button>`
      : `<button type="button" class="btn big block primary pressable" id="cop-next" style="font-size:17px">Continuar ${icon("arrow-right", 20)}</button>`}`;
}

function redraw() {
  const el = document.getElementById("cop-form");
  if (!el) return;
  el.innerHTML = formInner();
  window.scrollTo(0, 0);
  bindForm();
}

function readStep() {
  const s = visible()[at];
  const fail = (t) => { document.getElementById("cop-msg").innerHTML = `<div class="hint bad">${esc(t)}</div>`; return false; };
  if (s.id === "budget") {
    const v = Number(String(document.getElementById("budget").value).replace(/\D/g, ""));
    if (!(v >= 500)) return fail("Digite um orçamento de pelo menos R$ 500.");
    A.budget = v;
  }
  if (s.id === "dates") {
    const f = document.getElementById("d-from").value, t = document.getElementById("d-to").value;
    const mn = Number(document.getElementById("d-min").value), mx = Number(document.getElementById("d-max").value);
    if (!f || f <= todayIso()) return fail("Escolha uma data inicial a partir de amanhã.");
    if (!t || t <= f) return fail("A data final precisa ser depois da inicial.");
    if (daysBetween(f, t) > 180) return fail("A janela pode ter no máximo 6 meses.");
    if (!(mn >= 2 && mx >= mn && mx <= 30)) return fail("Duração: mínimo de 2 dias e máximo de 30, com o máximo maior que o mínimo.");
    if (mn > daysBetween(f, t)) return fail("A janela de datas é menor que a duração mínima.");
    Object.assign(A, { date_from: f, date_to: t, min_days: mn, max_days: mx });
  }
  const need = { climate: "climate", beach: "beach", scope: "scope" }[s.id];
  if (need && A[need] == null) return fail("Escolha uma opção.");
  if (s.id === "interests" && !(A.interests || []).length) return fail("Marque pelo menos uma coisa.");
  if (s.id === "pace") A.notes = document.getElementById("notes").value.trim();
  return true;
}

function bindForm() {
  const root = document.getElementById("cop-form");
  root.querySelectorAll("[data-budget]").forEach((b) => b.addEventListener("click", () => { A.budget = Number(b.dataset.budget); redraw(); }));
  document.getElementById("budget")?.addEventListener("input", (e) => {
    const n = e.target.value.replace(/\D/g, "");
    e.target.value = n ? Number(n).toLocaleString("pt-BR") : "";
  });
  root.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.st, min = k === "children" ? 0 : 1, max = k === "children" ? 6 : 9;
    A[k] = Math.min(max, Math.max(min, A[k] + Number(b.dataset.d)));
    b.parentElement.querySelector("output").textContent = A[k];
  }));
  root.querySelectorAll(".cop-choice").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    let v = b.dataset.v;
    if (v === "true" || v === "false") v = v === "true";
    if (b.hasAttribute("data-multi")) {
      const set = new Set(A[k] || []);
      set.has(v) ? set.delete(v) : set.add(v);
      A[k] = [...set];
      b.classList.toggle("on");
      return;
    }
    A[k] = v;
    root.querySelectorAll(`.cop-choice[data-k="${k}"]`).forEach((x) => x.classList.toggle("on", x === b));
    // escolha única: avança sozinho
    setTimeout(() => { if (readStep()) { at++; redraw(); } }, 180);
  }));
  document.getElementById("cop-prev")?.addEventListener("click", () => { at = Math.max(0, at - 1); redraw(); });
  document.getElementById("cop-next")?.addEventListener("click", () => { if (readStep()) { at = Math.min(visible().length - 1, at + 1); redraw(); } });
  document.getElementById("cop-send")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const answers = { ...A, passport: A.scope === "national" ? false : A.passport, us_visa: A.scope === "national" ? false : A.us_visa };
      const row = await q(sb.from("copilot_requests").insert({ answers }).select("id").single());
      at = 0;
      location.hash = `#/copiloto/${row.id}`;
    } catch (err) { e.currentTarget.disabled = false; document.getElementById("cop-msg").innerHTML = `<div class="hint bad">${esc(friendlyError(err))}</div>`; }
  });
}
viewCopilotForm.after = bindForm;

// ---------------------------------------------------------------------------
// Resultado (a tela atualiza sozinha enquanto o robô trabalha)
// ---------------------------------------------------------------------------
export async function viewCopilotResult(id) {
  const row = await q(sb.from("copilot_requests").select("*").eq("id", id).maybeSingle());
  if (!row) return `<main class="page">${back("#/copiloto", "Copiloto")}<div class="card pad">Consulta não encontrada.</div></main>`;
  S.current = { copilot: row };
  return `<main class="page">${back("#/copiloto", "Copiloto")}<div id="cop-result">${await resultBody(row)}</div></main>`;
}
viewCopilotResult.after = (id) => {
  const row = S.current?.copilot;
  if (!row || ["done", "error"].includes(row.status)) return;
  const myHash = location.hash, started = Date.now();
  const timer = setInterval(async () => {
    if (location.hash !== myHash) return clearInterval(timer);
    try {
      const r = await q(sb.from("copilot_requests").select("*").eq("id", id).maybeSingle());
      if (location.hash !== myHash) return clearInterval(timer);
      document.getElementById("cop-result").innerHTML = await resultBody(r);
      if (["done", "error"].includes(r.status) || Date.now() - started > 15 * 60000) clearInterval(timer);
    } catch {}
  }, 5000);
};

async function resultBody(r) {
  const a = r.answers || {};
  const people = (a.adults || 1) + (a.children || 0);
  if (r.status === "error") {
    return `<div class="card prep"><div style="font-size:40px">😕</div><h2 class="lg xb">Não deu certo desta vez</h2><p class="sm muted" style="margin:6px 0 14px">${esc(r.error || "Erro desconhecido.")}</p>
      <a class="btn primary" href="#/copiloto/novo">Tentar de novo</a></div>`;
  }
  if (r.status !== "done") {
    return `<section class="card prep"><div class="spin"></div><h2 class="lg xb">O Copiloto está montando suas viagens…</h2>
      <p class="sm sb primary-t" style="margin-top:8px">${esc(r.stage || "Começando…")}</p>
      <p class="sm muted" style="margin-top:8px">Leva alguns minutos. Pode sair desta tela: avisamos por notificação quando ficar pronto.</p></section>`;
  }
  const res = r.result || {};
  if (res.empty || !(res.options || []).length) {
    return `<div class="card prep"><div style="font-size:40px">🔍</div><h2 class="lg xb">Nada coube desta vez</h2><p class="sm muted" style="margin:6px 0 14px">${esc(res.reason || "Tente outras respostas.")}</p>
      <a class="btn primary" href="#/copiloto/novo">Ajustar respostas</a></div>`;
  }
  const dests = await loadDestinations(res.options.map((o) => o.code));
  return `<div class="page-title"><h1>Suas 2 viagens ✨</h1><p>${esc(res.intro || "")}</p></div>
    <p class="xs muted">${brl(a.budget)} · ${people} pessoa${people > 1 ? "s" : ""} · ${fmtShort(a.date_from)} a ${fmtShort(a.date_to)} · ${res.considered || 0} destinos analisados</p>
    ${res.options.map((o, i) => optionCard(o, i, a, people, dests[o.code])).join("")}
    <a class="btn block cardbg pressable" href="#/copiloto/novo" style="margin-top:16px">${icon("refresh-cw", 16)} Refazer com outras respostas</a>`;
}

function optionCard(o, i, a, people, dest) {
  const c = o.cost || {};
  const total = o.total || 0;
  const over = total - Number(a.budget);
  const rows = [["✈️ Passagens (preço real)", c.flight], [`🏨 Hospedagem · ${o.days} noites${o.hotel_real ? " (preço real)" : " (estimativa)"}`, c.hotel], ["🍽️ Alimentação (estimativa)", c.food], ["🚇 Transporte local (estimativa)", c.transport], ["🎟️ Passeios (estimativa)", c.activities]];
  const p = new URLSearchParams({ dest: o.code, nome: o.city, de: o.depart, ate: o.return, adultos: String(a.adults || 1) });
  const stay = new URLSearchParams({ d: o.code, nome: o.city, de: o.depart, ate: o.return, adultos: String(people) });
  const ph = photo(dest, 960) || o.photo;
  return `<article class="card cop-option fade-up" style="animation-delay:${i * 120}ms;margin-top:16px">
    <div class="rhero" style="border-radius:var(--r-xl) var(--r-xl) 0 0"><span class="ph" ${bg(ph)}></span><span class="bg-fade"></span>
      <span class="tr" style="display:flex;gap:6px">${pill(`${o.match || "–"}% a sua cara`, "lime")}</span>
      <div style="position:absolute;left:12px;top:12px">${favBtn("guide", o.code, { title: o.city, subtitle: o.country, photo: ph, link: `#/guide/${o.code}` })}</div>
      <div class="bottom"><p class="xs" style="opacity:.85">Opção ${i + 1} · ${flag(o.country_code)} ${esc(o.country)}</p><h2 class="display xb" style="font-size:30px;line-height:1.1">${esc(o.city)}</h2><p class="sm" style="opacity:.9">${esc(o.headline || "")}</p></div>
    </div>
    <div class="pad stack">
      <div class="row wrap" style="gap:6px">${pill(`📅 ${fmtShort(o.depart)} → ${fmtShort(o.return)} · ${o.days} dias`, "primary")}${o.clima ? pill(`🌡️ ${o.clima.tmin}°–${o.clima.tmax}°C · chuva em ${o.clima.rain_days} de ${o.clima.days} dias`) : ""}${(o.vibe || []).map((v) => pill(esc(v))).join("")}</div>
      <p class="sm">${esc(o.why || "")}</p>
      <div class="${over > 0 ? "soft-box" : "best-box"}">
        <div class="row between"><p class="sm sb">Custo total estimado</p>${over > 0 ? pill(`passa ${brl(over)} do orçamento`, "warn") : pill(`sobra ${brl(-over)}`, "good")}</div>
        <p class="price-xl">${brl(total)}</p><p class="xs muted">${brl(o.per_person)} por pessoa · ${people} pessoa${people > 1 ? "s" : ""}</p>
        <div style="margin-top:10px">${rows.map(([l, v]) => `<div class="cost-row"><div class="row between sm"><span>${l}</span><b>${brl(v)}</b></div><div class="cost-bar"><i style="width:${total ? ((v || 0) / total) * 100 : 0}%"></i></div></div>`).join("")}</div>
        ${o.hotel ? `<p class="xs muted" style="margin-top:8px">Hotel de referência: ${esc(o.hotel.example)}${o.hotel.rating ? ` (nota ${Number(o.hotel.rating).toLocaleString("pt-BR")})` : ""}, ${brl(o.hotel.per_night)}/noite.</p>` : ""}
      </div>
      <details class="cop-days" ${i === 0 ? "open" : ""}><summary class="b row between">🗺️ Roteiro sugerido ${icon("chevron-right", 18)}</summary>
        ${(o.itinerary || []).map((d) => `<div class="cop-day"><span class="pill primary">${esc(d.day)}</span><div><p class="sb">${esc(d.title)}</p><p class="sm muted">${esc(d.text)}</p></div></div>`).join("")}</details>
      ${(o.tips || []).length ? `<div class="tip" style="display:block"><p class="b">💡 Dicas do Copiloto</p><ul class="sm" style="margin-top:6px">${o.tips.map((t) => `<li style="margin-top:4px">• ${esc(t)}</li>`).join("")}</ul></div>` : ""}
      <div class="grid3" style="gap:8px">
        <a class="btn primary sm pressable" style="flex-direction:column;padding:10px 6px" href="#/nova?${p}">${icon("plane", 18)} Vigiar passagem</a>
        <a class="btn sm pressable" style="flex-direction:column;padding:10px 6px" href="#/guide/${esc(o.code)}?nome=${encodeURIComponent(o.city)}&de=${o.depart}&ate=${o.return}">${icon("earth", 18)} Ver guia</a>
        <a class="btn sm pressable" style="flex-direction:column;padding:10px 6px" href="#/hospedagem?${stay}">${icon("bed-double", 18)} Ver hotéis</a>
      </div>
    </div>
  </article>`;
}
