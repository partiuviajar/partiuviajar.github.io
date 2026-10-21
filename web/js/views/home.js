// Home: banner em slide, últimas atualizações, conversor, atalhos, promoção do dia, guias e dica.
import { sb, S, q, cached, esc, brl, ago, fmtShort, daysBetween, flag, photo, bg, userName, loadDestinations, place } from "../core.js";
import { icon } from "../icons.js";
import { pill, thermo, changeArrow, converter, bindConverter, countdownText, daysLeft, priceFor, bestDates } from "../ui.js";
import { loadRouteStats } from "../data.js";

const TIPS = [
  "Voos nacionais costumam ficar mais baratos 1–3 meses antes; internacionais, 2–6 meses.",
  "Terça e quarta costumam ter as passagens mais baratas para viajar.",
  "Na viagem longa, duas passagens só de ida podem sair mais baratas que ida e volta.",
  "Datas flexíveis economizam: use o modo “Mês inteiro” e deixe o robô achar o dia mais barato.",
  "Preço caiu muito de repente? Pode ser erro de tarifa: compre rápido e só depois reserve o resto.",
];

let heroTimer = null;

export async function viewHome() {
  const [{ stats, dests }, deals, lastAlert] = await Promise.all([
    loadRouteStats(),
    cached("deals", () => q(sb.from("deals").select("*").order("price").limit(300))).catch(() => []),
    cached("alerts:last", () => q(sb.from("alerts").select("price,created_at,route_id,depart_date,return_date,routes(origin_label,destination_label,origin,destination)").order("created_at", { ascending: false }).limit(1)), 30000).catch(() => []),
  ]);
  const intl = deals.filter((d) => d.country_code !== "BR");
  const extra = await loadDestinations(intl.slice(0, 30).map((d) => d.destination));
  const allDest = { ...extra, ...dests };
  const active = stats.filter((s) => s.r.active);
  const slides = active.filter((s) => s.price != null);
  const next = active.filter((s) => daysLeft(s.start) >= 0).sort((a, b) => daysLeft(a.start) - daysLeft(b.start))[0];
  const promo = intl.find((d) => photo(allDest[d.destination])) || intl[0];
  // dois guias com foto, de destinos diferentes da promoção
  const guideCodes = [...new Set([...active.map((s) => s.r.destination), ...intl.map((d) => d.destination)])]
    .filter((c) => c !== promo?.destination && photo(allDest[c])).slice(0, 2);
  const tip = TIPS[new Date().getDate() % TIPS.length];
  S.current = { slides };
  S.ambient = photo(slides[0]?.dest, 500);
  const alert = lastAlert[0];

  if (!stats.length) {
    return `<main class="page wide">
      ${hero([])}
      <div class="card pad center"><div style="font-size:40px">✈️</div><h2 class="lg xb">Nenhuma rota ainda</h2>
        <p class="sm muted" style="margin:4px 0 14px">Cadastre a viagem que você quer e o robô começa a vigiar os preços 24 h por dia.</p>
        <a class="btn brand" href="#/nova">${icon("plus", 18)} Cadastrar primeira rota</a></div>
      ${quick()}
      ${promo ? promoTile(promo, allDest) : ""}
    </main>`;
  }

  return `<main class="page wide">
    ${hero(slides)}

    <div class="bento md4">
      <section class="card pad span2 md-row2">
        <div class="row between" style="margin-bottom:4px"><h3 class="b">Últimas atualizações</h3><a class="xs sb primary-t" href="#/rotas">Ver rotas</a></div>
        <ul class="updates">${stats.map((s) => `<li><a href="#/rota/${s.r.id}">
          <span class="thumb" ${bg(photo(s.dest, 330))}></span>
          <span class="grow"><p class="sb truncate">${esc(place(s.r, "destination"))}</p><p class="xs muted truncate">${!s.r.active ? "pausada" : s.best ? ago(s.best.checked_at) : "aguardando verificação"}</p></span>
          <span style="text-align:right;flex:none">${s.price != null ? `<span class="display b">${brl(s.price)}</span>
            <p class="tiny muted">${esc(bestDates(s.best))}</p><p class="tiny muted">${esc(priceFor(s.r, s.best).short)}</p>` : `<span class="display b">…</span>`}</span>${changeArrow(s.change)}
        </a></li>`).join("")}</ul>
        <a class="soft-link" href="#/alertas" style="margin-top:8px">Ver todos os alertas salvos ${icon("chevron-right", 16)}</a>
      </section>

      <section class="card pad span2"><h3 class="b" style="margin-bottom:8px">💱 Conversor de moedas</h3>${converter("home-conv", "EUR")}</section>

      ${next ? `<a class="card tile pressable" href="#/rota/${next.r.id}">
        <p class="xs sb muted">Próxima viagem</p><p class="big-num">${Math.max(0, daysLeft(next.start))}</p>
        <p class="xs muted truncate">dias para ${esc(place(next.r, "destination"))}</p><span class="deco">✈️</span></a>`
        : `<a class="card tile pressable" href="#/nova"><p class="xs sb muted">Próxima viagem</p><p class="big-num">+</p><p class="xs muted">cadastre uma rota</p><span class="deco">✈️</span></a>`}
      <a class="card tile pressable" href="#/alertas">
        <p class="xs sb muted row" style="gap:4px">${icon("bell", 14)} Último alerta</p>
        ${alert ? `<p class="display xb good-t" style="font-size:24px;line-height:32px">${brl(alert.price)}</p>
          <p class="xs muted truncate">${esc(alertRoute(alert))} · ${ago(alert.created_at)}</p>`
          : `<p class="display xb muted" style="font-size:24px;line-height:32px">–</p><p class="xs muted">nenhum ainda</p>`}
      </a>
    </div>

    ${quick()}

    <div class="bento md4">
      ${promo ? promoTile(promo, allDest) : ""}
      ${guideCodes.map((c) => { const d = allDest[c]; return `<a class="photo-tile pressable ${guideCodes.length === 1 ? "span2" : ""}" href="#/guide/${esc(c)}">
        <span class="ph" ${bg(photo(d, 500))}></span><span class="bg-fade"></span>
        <span class="tl">${pill("Guide", "plain")}</span>
        <div class="bottom" style="padding:12px"><div class="grow"><p class="display b lg truncate">${flag(d.country_code)} ${esc(d.name)}</p><p class="tiny truncate" style="opacity:.85">${esc(d.country_name || "")}</p></div></div>
      </a>`; }).join("")}
      <section class="tip span2 md-span4">${icon("lightbulb", 20)}<div><p class="b">Dica do Radar</p><p class="sm">${esc(tip)}</p></div></section>
    </div>
  </main>`;
}

viewHome.after = () => {
  bindConverter("home-conv");
  startHero();
};

function alertRoute(a) {
  const r = a.routes;
  return r ? `${r.origin_label || r.origin} → ${r.destination_label || r.destination}` : "Rota";
}

function hero(slides) {
  const s0 = slides[0];
  return `<section class="hero" id="hero">
    ${slides.map((s, i) => `<img class="hero-slide ${i === 0 ? "on" : ""}" src="${esc(photo(s.dest, 960) || "")}" alt="" ${photo(s.dest, 960) ? "" : 'style="display:none"'}>`).join("")}
    <span class="bg-fade"></span>
    <div class="hero-hello"><p class="bubble-text">Bem-vindo,</p><p class="bubble-text">${esc(userName())}!</p></div>
    ${s0 ? `<a class="hero-info" id="hero-info" href="#/rota/${s0.r.id}">${heroInfo(s0)}</a>
      ${slides.length > 1 ? `<div class="hero-dots" id="hero-dots">${slides.map((s, i) => `<button type="button" class="${i === 0 ? "on" : ""}" data-i="${i}" aria-label="Ver ${esc(place(s.r, "destination"))}"></button>`).join("")}</div>` : ""}`
      : `<div class="hero-info"><p class="display b" style="font-size:24px">Para onde vamos?</p><p class="xs" style="opacity:.8">Cadastre uma rota e acompanhe o preço aqui.</p></div>`}
  </section>`;
}

function heroInfo(s) {
  return `<div class="row between" style="align-items:flex-end;gap:12px">
      <div class="grow fade-up">
        ${s.verdict ? `<p class="xs" style="opacity:.8;font-weight:500">${s.verdict.emoji} ${esc(s.verdict.title)}</p>` : ""}
        <p class="xs" style="opacity:.85">${esc(place(s.r, "origin"))} →</p>
        <p class="display b truncate" style="font-size:26px;line-height:30px">${esc(place(s.r, "destination"))}</p>
        <p class="xs truncate" style="opacity:.8">${countdownText(s.start) ? `✈️ ${countdownText(s.start)} · ` : ""}${s.best?.return_date ? `${fmtShort(s.best.depart_date)} → ${fmtShort(s.best.return_date)}` : s.best ? fmtShort(s.best.depart_date) : ""}</p>
      </div>
      <span style="text-align:right;flex:none"><span class="price-chip">${brl(s.price)}</span><p class="tiny" style="opacity:.85;margin-top:4px">${esc(priceFor(s.r, s.best).short)}</p></span>
    </div>
    <div style="max-width:384px">${thermo(s.price, s.normal, true)}</div>`;
}

function startHero() {
  clearInterval(heroTimer);
  const slides = S.current?.slides || [];
  const el = document.getElementById("hero");
  if (!el || slides.length < 2) return;
  let i = 0, x0 = null;
  const go = (n) => {
    i = (n + slides.length) % slides.length;
    el.querySelectorAll(".hero-slide").forEach((img, k) => img.classList.toggle("on", k === i));
    el.querySelectorAll("#hero-dots button").forEach((b, k) => b.classList.toggle("on", k === i));
    const info = document.getElementById("hero-info");
    info.href = `#/rota/${slides[i].r.id}`;
    info.innerHTML = heroInfo(slides[i]);
    restart();
  };
  const restart = () => {
    clearInterval(heroTimer);
    heroTimer = setInterval(() => { if (!document.getElementById("hero")) return clearInterval(heroTimer); go(i + 1); }, 5000);
  };
  document.getElementById("hero-dots")?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { e.preventDefault(); go(Number(b.dataset.i)); } });
  el.addEventListener("touchstart", (e) => (x0 = e.touches[0].clientX), { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1));
    x0 = null;
  });
  restart();
}

function quick() {
  const tile = (href, ic, label, brand = false) => `<a class="quick pressable ${brand ? "bg-brand shadow-float" : "card"}" href="${href}"><span class="quick-ic">${icon(ic, 20)}</span><span>${label}</span></a>`;
  return `<div class="grid4">
    ${tile("#/nova", "plus", "Nova rota", true)}
    ${tile("#/explorar", "compass", "Promoções")}
    ${tile("#/guide", "earth", "Guide")}
    ${tile("#/hospedagem", "bed-double", "Hospedagem")}
  </div>`;
}

function promoTile(d, dests) {
  const days = d.return_date ? daysBetween(d.depart_date, d.return_date) : null;
  return `<a class="photo-tile pressable span2" href="#/explorar">
    <span class="ph" ${bg(photo(dests[d.destination], 960))}></span><span class="bg-fade"></span>
    <span class="tl">${pill("🔥 Promoção do dia", "lime")}</span>
    <div class="bottom"><div class="grow"><p class="display b truncate" style="font-size:20px;line-height:28px">${esc(d.destination_label || d.destination)}</p>
      <p class="xs truncate" style="opacity:.85">${fmtShort(d.depart_date)}${d.return_date ? ` → ${fmtShort(d.return_date)}` : ""}${days ? ` · ${days} dias` : ""} · ida e volta por pessoa</p></div>
      <p class="display xb" style="font-size:24px;flex:none">${brl(d.price)}</p></div>
  </a>`;
}
