// Guide: globo + destinos (índice) e o guia de cada cidade, com dados reais
// (fotos/pontos turísticos/passeios preparados pelo robô; clima e câmbio ao vivo; preços reais de voo e hotel).
import { sb, S, q, cached, invalidate, favBtn, friendlyError, esc, brl, ago, fmtShort, todayIso, addDays, daysBetween, isoDaysAgo, median, toast, flag, photo, bg, plain, MONTHS, parseDate, isoOf } from "../core.js";
import { icon } from "../icons.js";
import { pill, seg, bindSeg, secTitle, converter, bindConverter, autocomplete } from "../ui.js";

const RIO = [-22.9, -43.2];
const SCHENGEN = "AT BE BG HR CZ DK EE FI FR DE GR HU IS IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE CH".split(" ");
const RG_COUNTRIES = "AR UY PY CL BO PE CO EC VE".split(" ");

// ---------------------------------------------------------------------------
// Índice: "Para onde vamos?"
// ---------------------------------------------------------------------------
const gstate = { scope: "intl", focus: null, list: [] };
let globe = null;

export async function viewGuideIndex() {
  const [dests, deals, routes, requests] = await Promise.all([
    cached("guide:dests", () => q(sb.from("destinations").select("code,name,country_code,country_name,thumb,lat,lon,summary").not("lat", "is", null).limit(300)), 120000),
    cached("deals", () => q(sb.from("deals").select("*").order("price").limit(300))).catch(() => []),
    q(sb.from("routes").select("destination,active")),
    q(sb.from("guide_requests").select("code,name,status,created_at").order("created_at", { ascending: false }).limit(6)).catch(() => []),
  ]);
  const fromPrice = {};
  for (const d of deals) if (fromPrice[d.destination] == null) fromPrice[d.destination] = Number(d.price);
  const mine = new Set(routes.filter((r) => r.active).map((r) => r.destination));
  // suas rotas primeiro, depois quem tem foto e promoção
  const list = dests.filter((d) => d.thumb || mine.has(d.code))
    .sort((a, b) => (mine.has(b.code) - mine.has(a.code)) || ((fromPrice[a.code] ?? 1e9) - (fromPrice[b.code] ?? 1e9)));
  Object.assign(gstate, { list, fromPrice, mine, focus: null });
  const chips = list.filter((d) => mine.has(d.code)).concat(list.filter((d) => !mine.has(d.code) && d.country_code !== "BR").slice(0, 8));
  return `<main class="page">
    <div class="page-title center"><h1>Para onde vamos?</h1><p>Gire o globo, toque num destino ou busque qualquer cidade</p></div>
    ${requests.length ? `<div class="city-chips">${requests.map((r) => `<a class="row" style="gap:6px" href="#/guide/${esc(r.code)}?nome=${encodeURIComponent(r.name || r.code)}">${r.status === "done" ? "✅" : r.status === "error" ? "⚠️" : "⏳"} ${esc(r.name || r.code)}</a>`).join("")}<a href="#/favoritos">❤️ Favoritos</a></div>` : `<div class="city-chips"><a href="#/favoritos">❤️ Seus favoritos</a></div>`}
    <div class="globe-wrap"><canvas id="globe"></canvas><div id="globe-card"></div></div>
    <div class="city-chips" id="city-chips">${chips.map((d) => `<button type="button" class="pressable" data-c="${esc(d.code)}">${flag(d.country_code)} ${esc(d.name)}</button>`).join("")}</div>
    <div class="search">${icon("search", 20)}<input id="g-search" type="search" autocomplete="off" placeholder="Buscar cidade ou país (ex.: Lisboa, Chile)"><button class="clear" id="g-clear" hidden aria-label="Limpar">${icon("x", 20)}</button>
      <div class="card search-results" id="g-results" hidden></div></div>
    ${seg("g-scope", [["intl", "🌎 Internacional"], ["nac", "🇧🇷 Nacional"]], gstate.scope)}
    <div class="gbento" id="g-grid"></div>
  </main>`;
}

viewGuideIndex.after = async () => {
  const drawGrid = () => {
    const items = gstate.list.filter((d) => (gstate.scope === "nac") === (d.country_code === "BR")).slice(0, 30);
    document.getElementById("g-grid").innerHTML = items.length ? items.map((d, i) => {
      const big = i % 3 === 0;
      const price = gstate.fromPrice[d.code];
      return `<a class="photo-tile pressable fade-up ${big ? "big" : ""}" style="animation-delay:${i * 60}ms" href="#/guide/${esc(d.code)}">
        <span class="ph" ${bg(photo(d, big ? 960 : 500))}></span><span class="bg-fade"></span>
        <span class="tr">${pill(esc(gstate.mine.has(d.code) ? "✈️ sua rota" : d.country_name || ""), "plain")}</span>
        <div class="bottom" style="display:block"><p class="display xb truncate" style="font-size:${big ? 30 : 18}px;line-height:1.15">${esc(d.name)}</p>
          <p class="xs truncate" style="opacity:.85">${flag(d.country_code)} ${esc(d.country_name || "")}${big && d.summary ? ` · ${esc(firstSentence(d.summary, 70))}` : ""}</p>
          ${price ? `<p class="xs sb" style="margin-top:4px">voo a partir de <span style="color:var(--lime)">${brl(price)}</span></p>` : ""}</div>
      </a>`;
    }).join("") : `<div class="card pad sm muted span2">Nenhum destino nesta categoria ainda. Busque uma cidade acima para preparar o guia.</div>`;
  };
  bindSeg("g-scope", (v) => { gstate.scope = v; drawGrid(); });
  drawGrid();

  // chips: focam a cidade no globo
  const focus = (code) => {
    gstate.focus = gstate.focus === code ? null : code;
    document.querySelectorAll("#city-chips button").forEach((b) => b.classList.toggle("on", b.dataset.c === gstate.focus));
    const d = gstate.list.find((x) => x.code === gstate.focus);
    document.getElementById("globe-card").innerHTML = d ? `<a class="card globe-card fade-up" href="#/guide/${esc(d.code)}">
      <span class="thumb" style="width:48px;height:48px" ${bg(photo(d, 330))}></span>
      <span class="grow"><p class="b truncate">${flag(d.country_code)} ${esc(d.name)}</p><p class="xs muted truncate">${esc(firstSentence(d.summary || d.country_name || "", 60))}</p></span>
      <span class="go">${icon("arrow-right", 16)}</span></a>` : "";
    globe?.focus(d ? [d.lat, d.lon] : null);
  };
  document.getElementById("city-chips").addEventListener("click", (e) => { const b = e.target.closest("button[data-c]"); if (b) focus(b.dataset.c); });

  // busca: primeiro entre os destinos já preparados; senão, qualquer cidade (o robô prepara o guia)
  const input = document.getElementById("g-search"), results = document.getElementById("g-results"), clear = document.getElementById("g-clear");
  let remote = [], timer;
  const drawResults = () => {
    const term = plain(input.value.trim());
    clear.hidden = !term;
    if (!term) { results.hidden = true; return; }
    const local = gstate.list.filter((d) => plain(`${d.name} ${d.country_name}`).includes(term)).slice(0, 6);
    const extra = remote.filter((r) => !local.some((l) => l.code === r.code)).slice(0, 5);
    results.innerHTML = local.map((d) => `<a href="#/guide/${esc(d.code)}"><span class="thumb" ${bg(photo(d, 330))}></span><span class="grow"><p class="sb">${esc(d.name)}</p><p class="xs muted">${flag(d.country_code)} ${esc(d.country_name || "")}</p></span></a>`).join("")
      + extra.map((r) => `<a href="#/guide/${esc(r.code)}?nome=${encodeURIComponent(r.name)}"><span class="thumb" style="display:grid;place-items:center">${icon("map-pin", 18)}</span><span class="grow"><p class="sb">${esc(r.name)}</p><p class="xs muted">${esc(r.country_name || "")} · solicitar guia</p></span></a>`).join("")
      || `<p class="sm muted" style="padding:16px">Procurando “${esc(input.value)}”…</p>`;
    results.hidden = false;
  };
  input.addEventListener("input", () => {
    drawResults();
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) return;
    timer = setTimeout(async () => {
      try {
        remote = await (await fetch(`https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(term)}&locale=pt&types[]=city`)).json();
        drawResults();
        if (!results.innerHTML.includes("<a")) results.innerHTML = `<p class="sm muted" style="padding:16px">Não achamos “${esc(term)}”.</p>`;
      } catch {}
    }, 250);
  });
  clear.addEventListener("click", () => { input.value = ""; remote = []; drawResults(); });
  input.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 200));
  input.addEventListener("focus", drawResults);

  // globo 3D (cobe)
  try {
    globe?.destroy();
    globe = await makeGlobe(document.getElementById("globe"), gstate.list);
  } catch (e) { console.warn("globo", e); }
};

async function makeGlobe(canvas, list) {
  if (!canvas) return null;
  const { default: createGlobe } = await import("https://cdn.jsdelivr.net/npm/cobe@0.6.4/+esm");
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  let phi = 0.6, theta = 0.25, target = null, drag = null, width = 0;
  const dpr = Math.min(1.5, devicePixelRatio || 1);
  const resize = () => {
    width = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 320;
    canvas.width = canvas.height = Math.round(width * dpr);
  };
  resize();
  const g = createGlobe(canvas, {
    devicePixelRatio: dpr, width: width * dpr, height: width * dpr, phi, theta,
    dark: dark ? 1 : 0, diffuse: 1.4, mapSamples: 12000, mapBrightness: dark ? 5 : 8, mapBaseBrightness: 0.05,
    baseColor: dark ? [0.25, 0.3, 0.55] : [0.86, 0.9, 1], glowColor: dark ? [0.25, 0.3, 0.7] : [0.75, 0.82, 1], markerColor: [0.83, 1, 0.23],
    markers: [{ location: RIO, size: 0.07 }, ...list.slice(0, 80).map((d) => ({ location: [d.lat, d.lon], size: 0.05 }))],
    onRender: (state) => {
      if (!document.body.contains(canvas)) { setTimeout(() => g.destroy(), 0); return; }
      if (drag == null) {
        if (target) {
          const tp = Math.PI - ((target[1] * Math.PI) / 180 - Math.PI / 2), tt = (target[0] * Math.PI) / 180;
          const d = ((tp - phi + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
          phi += d * 0.08; theta += (tt * 0.8 - theta) * 0.08;
        } else { phi += 0.003; theta += (0.25 - theta) * 0.05; }
      }
      state.phi = phi; state.theta = theta; state.width = width * dpr; state.height = width * dpr;
    },
  });
  requestAnimationFrame(() => (canvas.style.opacity = "1"));
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, phi }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; });
  canvas.addEventListener("pointermove", (e) => { if (drag) phi = drag.phi + (e.clientX - drag.x) / 150; });
  const up = () => { drag = null; canvas.style.cursor = "grab"; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  addEventListener("resize", resize);
  return { focus: (t) => (target = t), destroy: () => { g.destroy(); removeEventListener("resize", resize); } };
}

const firstSentence = (s, max = 90) => { const t = String(s || "").split(/(?<=\.)\s/)[0].replace(/\s*\([^)]*\)/g, ""); return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t; };

// ---------------------------------------------------------------------------
// Guia de uma cidade
// ---------------------------------------------------------------------------
export async function viewGuide(code) {
  const [d, req] = await Promise.all([
    q(sb.from("destinations").select("*").eq("code", code).maybeSingle()),
    q(sb.from("guide_requests").select("*").eq("code", code).order("created_at", { ascending: false }).limit(1)).then((r) => r[0]).catch(() => null),
  ]);
  const preparing = req && ["pending", "running"].includes(req.status) && Date.now() - new Date(req.created_at) < 15 * 60000;
  if (!d?.lat) {
    S.current = { request: { code, name: S.params.get("nome") || req?.name || d?.name || code, preparing } };
    return `<main class="page"><a class="back" href="#/guide">${icon("arrow-left", 16)} Guide</a>
      <section class="card prep" id="prep">${prepBody(S.current.request, req)}</section></main>`;
  }
  const [deals, routes, hotelSearches, related] = await Promise.all([
    q(sb.from("deals").select("price,depart_date,return_date,origin").eq("destination", code).order("price").limit(5)).catch(() => []),
    q(sb.from("routes").select("id,origin,destination,adults,active").eq("destination", code)),
    q(sb.from("hotel_searches").select("results,adults,checkin,checkout,created_at").eq("city_name", d.name).eq("status", "done").order("created_at", { ascending: false }).limit(3)).catch(() => []),
    q(sb.from("destinations").select("code,name,country_code,thumb").not("thumb", "is", null).neq("code", code).limit(60)).catch(() => []),
  ]);
  // preço real do voo por pessoa: promoção do robô ou o menor preço das suas rotas
  let flight = deals[0] ? { price: Number(deals[0].price), src: "promoção dos últimos dias" } : null;
  if (routes.length) {
    const ids = routes.map((r) => r.id);
    const rows = await q(sb.from("route_latest").select("route_id,price,leg").in("route_id", ids).gte("checked_at", isoDaysAgo(3)).order("price").limit(50)).catch(() => []);
    const ok = rows.filter((x) => !x.leg || x.leg === "rt" || x.leg === "combo")[0];
    if (ok) {
      const adults = routes.find((r) => r.id === ok.route_id)?.adults || 1;
      const per = Number(ok.price) / adults;
      if (!flight || per < flight.price) flight = { price: per, src: "sua rota" };
    }
  }
  // hotel: mediana do menor preço por noite das buscas feitas, por pessoa
  const nightly = hotelSearches.flatMap((h) => (h.results || []).map((x) => (x.night ? x.night / Math.max(1, Math.min(2, h.adults || 2)) : null)).filter(Boolean));
  const hotelNight = nightly.length ? median(nightly) : null;
  const tours = (d.experiences || []).filter((x) => x.price);
  const tourAvg = tours.length ? median(tours.map((x) => x.price)) : null;
  const attractions = d.attractions || [];
  const images = [photo(d, 1280) || d.image, ...attractions.filter((a) => a.image).slice(0, 8).map((a) => a.image.replace(/\?width=\d+/, "?width=960"))].filter(Boolean);
  const caps = [d.name, ...attractions.filter((a) => a.image).slice(0, 8).map((a) => a.name)];
  const intl = d.country_code !== "BR";
  const rel = related.filter((x) => (x.country_code !== "BR") === intl).slice(0, 10);
  const de = S.params.get("de"), ate = S.params.get("ate");
  S.current = { dest: d, de, ate, images, caps, flight, hotelNight, tourAvg, days: 7 };
  const f = d.facts || {};
  const plugs = plugInfo(f);
  const rules = entryRules(d.country_code);
  const stayLink = `#/hospedagem?d=${esc(code)}&nome=${encodeURIComponent(d.name)}${de ? `&de=${de}&ate=${ate && daysBetween(de, ate) <= 30 ? ate : addDays(de, 7)}` : ""}${S.params.get("adultos") ? `&adultos=${S.params.get("adultos")}` : ""}`;
  const tags = [intl ? "Internacional" : "Nacional", f.currency && f.currency !== "BRL" ? f.currency : null, (f.languages || [])[0], rules?.tag].filter(Boolean);

  return `<div>
    <section class="gallery"><div class="gallery-grid">
      ${images.slice(0, 5).map((src, i) => `<button type="button" data-i="${i}" aria-label="Ver foto ${i + 1}"><span class="ph" ${bg(src)}></span></button>`).join("")}
      <button type="button" class="gallery-back glass" onclick="history.length > 1 ? history.back() : (location.hash = '#/guide')" aria-label="Voltar">${icon("arrow-left", 20)}</button>
      ${images.length > 1 ? `<button type="button" class="gallery-count glass" data-i="0">Ver ${images.length} fotos</button>` : ""}
    </div></section>
    <main class="page">
      <nav class="sec-nav glass">${[["g-custos", "💸 Custos"], ["g-clima", "🌦️ Clima e tempo"], ["g-pontos", "📍 Pontos turísticos"], ...(tours.length ? [["g-passeios", "🎟️ Passeios"]] : []), ["g-info", "🧳 Info prática"]].map(([id, l]) => `<a href="#${id}" data-a>${l}</a>`).join("")}</nav>
      <div class="row between" style="align-items:flex-start;gap:12px">
        <div class="grow"><p class="sm sb muted">${flag(d.country_code)} ${esc(d.country_name || "")}</p>
          <h1 class="display xb" style="font-size:36px;line-height:40px">${esc(d.name)}</h1>
          <p class="muted">${esc(firstSentence(d.summary || "", 110))}</p></div>
        <div class="row" style="gap:8px">${favBtn("guide", code, { title: d.name, subtitle: d.country_name, photo: photo(d, 500), link: `#/guide/${code}` }, "big")}
        <button class="card share-btn pressable" id="share" aria-label="Compartilhar">${icon("share-2", 20)}</button></div>
      </div>
      <div class="row wrap" style="gap:6px">${tags.map((t) => pill(esc(t), "primary")).join("")}</div>

      <section class="card pad" id="g-visao"><div class="overview">
        <div class="facts-list">
          <h3 class="b">Em números</h3>
          <div class="fact-row">${icon("plane", 18)}<span class="grow">Voo ida e volta</span><b>${flight ? brl(flight.price) : "–"}</b></div>
          <div class="fact-row">${icon("bed-double", 18)}<span class="grow">Hotel por noite</span><b>${hotelNight ? brl(hotelNight) : `<a class="primary-t" href="${stayLink}">comparar</a>`}</b></div>
          <div class="fact-row">${icon("star", 18)}<span class="grow">Passeio (média)</span><b>${tourAvg ? brl(tourAvg) : "–"}</b></div>
          <div class="fact-row">${icon("map-pin", 18)}<span class="grow">Pontos turísticos</span><b>${attractions.length || "–"}</b></div>
          <p class="tiny muted">Preços por pessoa, de dados reais${flight ? ` (voo: ${flight.src})` : ""}.</p>
        </div>
        <div><h3 class="b">Sobre</h3><p class="sm muted" style="margin-top:4px">${esc(d.summary || "Sem resumo ainda.")}</p>
          <p class="sm" style="margin-top:12px" id="best-months"><b>Melhor época:</b> <span class="muted">calculando…</span></p>
          ${d.wiki_url ? `<a class="xs sb primary-t" style="display:inline-block;margin-top:8px" href="${esc(d.wiki_url)}" target="_blank" rel="noopener">Ler mais na Wikipedia ↗</a>` : ""}</div>
      </div></section>

      <div class="grid2">
        <a class="btn big bg-brand shadow-float pressable" style="font-size:16px" href="#/nova?dest=${esc(code)}&nome=${encodeURIComponent(d.name)}">${icon("plane", 20)} Vigiar passagem</a>
        <a class="btn big card pressable" style="font-size:16px" href="${stayLink}">${icon("bed-double", 20)} Ver hospedagem</a>
      </div>

      ${secTitle("🌦️ Previsão da semana", "", "g-clima")}
      <div class="weather" id="forecast">${Array.from({ length: 7 }, () => `<div class="card wday"><div class="skeleton" style="height:96px"></div></div>`).join("")}</div>
      <section class="card pad"><h3 class="b">Como costuma ser o tempo</h3><p class="sm muted" id="climate-text" style="margin-top:4px">Carregando o histórico…</p><div class="months" id="months"></div></section>

      ${secTitle("💸 Quanto custa a viagem", "", "g-custos")}
      <div class="grid3" style="gap:12px" id="days-pick">${[5, 7, 10].map((n) => `<button type="button" class="pressable ${n === 7 ? "bg-brand shadow-float" : "card"}" data-n="${n}" style="border-radius:var(--r-3xl);padding:16px;text-align:left"></button>`).join("")}</div>
      <section class="card pad" id="breakdown"></section>

      ${secTitle("📍 O que fazer", tourAvg ? pill(`média ${brl(tourAvg)}/passeio`, "primary") : "", "g-pontos")}
      ${attractions.length ? `<div class="sights">${attractions.slice(0, 12).map((a, i) => `<article class="card sight">
          <div class="sight-photo" ${bg(a.image)}><b>${i + 1}</b></div>
          <div class="grow"><p class="b" style="line-height:1.25">${esc(a.name)}</p>${a.desc ? `<p class="xs muted" style="margin-top:2px">${esc(a.desc)}</p>` : ""}
            <div class="row wrap" style="gap:6px;margin-top:8px">
              <a class="xs sb primary-t" href="${esc(a.link)}" target="_blank" rel="noopener">Saiba mais ↗</a>
              <a class="xs sb primary-t row" style="gap:2px;margin-left:auto" href="https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lon}" target="_blank" rel="noopener">${icon("map-pin", 12)} Mapa</a>
            </div></div>
        </article>`).join("")}</div>`
        : d.attractions_at ? `<div class="card pad sm muted">Não encontramos pontos turísticos cadastrados aqui.</div>`
        : `<div class="card pad center"><p class="sm muted">${preparing ? "⏳ Preparando pontos turísticos e passeios… você recebe uma notificação quando ficar pronto." : "Os pontos turísticos e passeios desta cidade ainda não foram preparados."}</p>
          ${preparing ? "" : `<button class="btn primary pressable" id="complete-guide" style="margin-top:10px">Completar guia</button>`}</div>`}
      ${tours.length ? `<h3 class="b" style="margin-top:20px" id="g-passeios">🎟️ Passeios com preço</h3>
        <div class="tours">${tours.map((x) => `<a class="card tour pressable rel" href="${esc(x.link)}" target="_blank" rel="noopener">
          ${favBtn("tour", x.link, { title: x.title, subtitle: `${d.name} · ${x.provider}${x.price ? ` · a partir de ${brl(x.price)}` : ""}`, photo: x.photo, link: x.link }, "over")}
          <span class="ph" ${bg(x.photo)}><span class="pill plain">${esc(x.provider)}</span></span>
          <div class="tour-body"><p class="tour-title">${esc(x.title)}</p>
            <p class="tiny muted">${x.rating ? `⭐ ${Number(x.rating).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}` : ""}${x.reviews ? ` · ${Number(x.reviews).toLocaleString("pt-BR")} avaliações` : ""}</p>
            <p class="xs" style="margin-top:auto">a partir de <b class="display primary-t" style="font-size:16px">${brl(x.price)}</b></p></div></a>`).join("")}</div>` : ""}
      <div class="row wrap" style="gap:6px;justify-content:center">${[["GetYourGuide", `https://www.getyourguide.com/pt-br/s/?q=${encodeURIComponent(d.name)}`], ["Civitatis", `https://www.civitatis.com/br/procurar?q=${encodeURIComponent(d.name)}`], ["Viator", `https://www.viator.com/pt-BR/searchResults/all?text=${encodeURIComponent(d.name)}`]].map(([n, u]) => `<a class="btn sm cardbg" href="${u}" target="_blank" rel="noopener">${n} ↗</a>`).join("")}</div>

      ${secTitle("🧳 Info prática", "", "g-info")}
      <div class="grid2">
        <div class="card info-tile"><p class="e">💱</p><p class="k">Moeda</p><p class="v" id="fx">${f.currency === "BRL" ? "Real (R$)" : esc(f.currency || "–")}</p></div>
        <div class="card info-tile"><p class="e">🕐</p><p class="k">Fuso</p><p class="v" id="tz">…</p></div>
        <div class="card info-tile"><p class="e">🗣️</p><p class="k">Idioma</p><p class="v">${esc((f.languages || []).join(", ") || "–")}</p></div>
        <div class="card info-tile"><p class="e">🔌</p><p class="k">Tomada</p><p class="v">${esc(plugs?.text || "–")}</p>${plugs ? `<p class="xs ${plugs.adapter ? "warn-t sb" : "muted"}">${plugs.adapter ? "leve adaptador" : "compatível com o Brasil"}</p>` : ""}</div>
      </div>
      ${f.currency && f.currency !== "BRL" ? `<section class="card pad"><h3 class="b" style="margin-bottom:8px">Converter para ${esc(f.currency)}</h3>${converter("guide-conv", f.currency)}</section>` : ""}
      ${rules ? `<section class="card pad"><h3 class="b">🛂 Entrada para brasileiros</h3><p class="sm" style="margin-top:4px">${esc(rules.text)}</p>
        <p class="hint warn" style="margin-top:8px">Confirme sempre no <a href="https://www.gov.br/mre/pt-br/assuntos/portal-consular" target="_blank" rel="noopener" style="text-decoration:underline">Portal Consular</a> antes de viajar.</p></section>` : ""}
      <section class="tip" style="display:block"><h3 class="b">💡 Dicas do Radar</h3><ul class="sm" style="margin-top:8px">${tipsFor(d, plugs, attractions).map((t) => `<li style="margin-top:6px">• ${esc(t)}</li>`).join("")}</ul></section>

      ${rel.length ? `${secTitle("Você também pode gostar")}
        <div class="scroller">${rel.map((x) => `<a class="related pressable" href="#/guide/${esc(x.code)}"><span class="ph" ${bg(photo(x, 500))}></span><span class="bg-fade"></span><b>${flag(x.country_code)} ${esc(x.name)}</b></a>`).join("")}</div>` : ""}
    </main>
  </div>`;
}

viewGuide.after = async () => {
  const c = S.current;
  if (c?.request) return bindRequest(c.request);
  if (!c?.dest?.lat) return;
  document.getElementById("complete-guide")?.addEventListener("click", (e) => requestGuide(c.dest.code, c.dest.name, e.currentTarget));
  const d = c.dest;
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  // compartilhar
  document.getElementById("share")?.addEventListener("click", async () => {
    try { if (navigator.share) await navigator.share({ title: `Guia de ${d.name}`, url: location.href }); else { await navigator.clipboard.writeText(location.href); toast("✅ Link copiado"); } } catch {}
  });
  // âncoras das seções (o roteador usa o #, então rola manualmente)
  document.querySelectorAll(".sec-nav [data-a]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); document.querySelector(a.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  // galeria
  document.querySelector(".gallery-grid")?.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) openLightbox(Number(b.dataset.i)); });
  bindConverter("guide-conv");
  drawCosts(7);
  document.getElementById("days-pick").addEventListener("click", (e) => { const b = e.target.closest("button[data-n]"); if (b) drawCosts(Number(b.dataset.n)); });

  const f = d.facts || {};
  if (f.currency && f.currency !== "BRL") {
    fetch(`https://open.er-api.com/v6/latest/${f.currency}`).then((r) => r.json()).then((j) => {
      const v = j?.rates?.BRL; if (!v) return;
      const num = (x, dec) => x.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
      set("fx", v < 0.2 ? `R$ 1 = ${num(1 / v, 1 / v >= 100 ? 0 : 2)} ${esc(f.currency)}` : `1 ${esc(f.currency)} = R$ ${num(v, 2)}`);
    }).catch(() => {});
  }
  // previsão de 7 dias + fuso
  fetch(`https://api.open-meteo.com/v1/forecast?latitude=${d.lat}&longitude=${d.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`).then((r) => r.json()).then((j) => {
    const t = j.daily;
    set("forecast", t.time.map((day, i) => `<div class="card wday ${i === 0 ? "today" : ""}">
      <p class="xs sb muted" style="text-transform:capitalize">${i === 0 ? "Hoje" : new Date(day + "T12:00").toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "")}</p>
      <p class="e">${wmo(t.weather_code[i])}</p><p class="display b">${Math.round(t.temperature_2m_max[i])}°</p><p class="xs muted">${Math.round(t.temperature_2m_min[i])}°</p>
      <p class="tiny sb primary-t" style="margin-top:4px">💧${t.precipitation_probability_max?.[i] ?? 0}%</p></div>`).join(""));
    const diff = Math.round((j.utc_offset_seconds + 10800) / 3600);
    set("tz", diff === 0 ? "Mesmo horário de Brasília" : `${diff > 0 ? "+" : ""}${diff} h de Brasília`);
  }).catch(() => set("forecast", `<p class="card pad sm muted">Não foi possível carregar a previsão agora.</p>`));

  // clima mês a mês (últimos 12 meses reais) e nas suas datas
  try {
    const end = addDays(todayIso(), -6), start = addDays(end, -364);
    const j = await (await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${d.lat}&longitude=${d.lon}&start_date=${start}&end_date=${end}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`)).json();
    const t = j.daily;
    const byM = Array.from({ length: 12 }, () => ({ t: [], rain: 0, n: 0 }));
    t.time.forEach((day, i) => { const m = Number(day.slice(5, 7)) - 1; byM[m].t.push((t.temperature_2m_max[i] + t.temperature_2m_min[i]) / 2); byM[m].n++; if (t.precipitation_sum[i] >= 1) byM[m].rain++; });
    const months = byM.map((m, i) => ({ m: MONTHS[i][0].toUpperCase(), name: MONTHS[i], t: Math.round(m.t.reduce((a, b) => a + b, 0) / (m.t.length || 1)), rain: m.n ? m.rain / m.n : 0 }));
    const lo = Math.min(...months.map((m) => m.t)) - 4, hi = Math.max(...months.map((m) => m.t));
    set("months", months.map((m) => `<div><span class="muted">${m.t}°</span><i class="${m.t >= 25 ? "hot" : m.t >= 15 ? "" : "cold"}" style="height:${((m.t - lo) / (hi - lo || 1)) * 70 + 10}px"></i><span>${m.m}</span></div>`).join(""));
    // melhor época: temperatura amena (17–28°C) e menos chuva
    const good = months.map((m, i) => ({ ...m, i, score: (m.t >= 17 && m.t <= 28 ? 1 : 0) - m.rain })).sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => a.i - b.i);
    set("best-months", `<b>Melhor época:</b> ${good.map((m) => m.name.slice(0, 3)).join(", ")} <span class="tiny muted">(clima mais agradável e menos chuva no último ano)</span>`);
    const warm = months.reduce((a, b) => (b.t > a.t ? b : a)), cold = months.reduce((a, b) => (b.t < a.t ? b : a)), wet = months.reduce((a, b) => (b.rain > a.rain ? b : a));
    let text = `Mais quente em ${warm.name} (média ${warm.t}°C), mais frio em ${cold.name} (${cold.t}°C). Mais chuvoso: ${wet.name} (chove em ${Math.round(wet.rain * 100)}% dos dias).`;
    if (c.de) {
      const from = c.de, to = c.ate && c.ate > from ? c.ate : addDays(from, 7);
      const yr = (iso) => { const x = parseDate(iso); x.setFullYear(x.getFullYear() - 1); return isoOf(x); };
      const idx = t.time.map((day, i) => [day, i]).filter(([day]) => day >= yr(from) && day <= yr(to)).map(([, i]) => i);
      if (idx.length) {
        const avg = (k) => Math.round(idx.reduce((a, i) => a + t[k][i], 0) / idx.length);
        text += ` Nas suas datas (${fmtShort(from)} a ${fmtShort(to)}), no ano passado: ${avg("temperature_2m_min")}° a ${avg("temperature_2m_max")}°C, chuva em ${idx.filter((i) => t.precipitation_sum[i] >= 1).length} de ${idx.length} dias.`;
      }
    }
    set("climate-text", esc(text));
  } catch { set("climate-text", "Não foi possível carregar o histórico do clima."); set("best-months", ""); }
};

// ---------------------------------------------------------------------------
// "Solicitar guia": o Supabase aciona o robô na hora; fica pronto em ~2 min e chega notificação
// ---------------------------------------------------------------------------
function prepBody(r, req) {
  if (r.preparing) {
    return `<div class="spin"></div><h2 class="lg xb">Preparando o guia de ${esc(r.name)}…</h2>
      <p class="sm muted" style="margin-top:6px">Buscando fotos, pontos turísticos, passeios e avaliações em várias fontes. Fica pronto em até 10 min e <b>avisamos por notificação</b>, pode sair desta tela.</p>
      <p class="xs muted" style="margin-top:10px">Esta página atualiza sozinha.</p>`;
  }
  return `<div style="font-size:44px">🧭</div><h2 class="lg xb">Ainda não temos o guia de ${esc(r.name)}</h2>
    <p class="sm muted" style="margin:6px 0 16px">Montamos seu guia buscando fotos, pontos turísticos, passeios e avaliações em várias fontes. Fica pronto em <b>até 10 min</b> e avisamos por notificação.</p>
    ${req?.status === "error" ? `<p class="hint bad" style="margin-bottom:12px">A última tentativa falhou: ${esc(req.error || "erro desconhecido")}</p>` : ""}
    <button class="btn big bg-brand shadow-float pressable" id="ask-guide" style="font-size:16px">${icon("earth", 20)} Solicitar guia</button>`;
}

async function requestGuide(code, name, btn) {
  if (btn) btn.disabled = true;
  try {
    await q(sb.from("guide_requests").insert({ code, name }));
    invalidate("guide:");
    toast("🧭 Pedido feito! Em até 10 min o guia fica pronto e avisamos por notificação.", 5000);
    dispatchEvent(new HashChangeEvent("hashchange"));
  } catch (err) { if (btn) btn.disabled = false; toast(friendlyError(err)); }
}

function bindRequest(r) {
  document.getElementById("ask-guide")?.addEventListener("click", (e) => requestGuide(r.code, r.name, e.currentTarget));
  if (!r.preparing) return;
  // confere a cada 8 s se ficou pronto
  const myHash = location.hash;
  const timer = setInterval(async () => {
    if (location.hash !== myHash) return clearInterval(timer);
    try {
      const req = (await q(sb.from("guide_requests").select("status").eq("code", r.code).order("created_at", { ascending: false }).limit(1)))[0];
      if (req && req.status !== "pending" && req.status !== "running") {
        clearInterval(timer);
        invalidate("guide:");
        if (req.status === "done") toast("🧭 Guia pronto!");
        dispatchEvent(new HashChangeEvent("hashchange"));
      }
    } catch {}
  }, 8000);
}

function drawCosts(days) {
  const c = S.current;
  c.days = days;
  const k = c.dest.facts?.costs || null; // estimativa diária (IA) quando não há preço real
  const fl = c.flight?.price || 0;
  const hotelPP = c.hotelNight || (k ? k.hotel_night_double / 2 : 0);         // por pessoa por noite (quarto duplo dividido)
  const parts = (n) => ({
    flight: fl,
    stay: hotelPP * n,
    food: k ? k.food_day * n : 0,
    transport: k ? k.transport_day * n : 0,
    fun: c.tourAvg ? c.tourAvg * Math.max(1, Math.round(n / 2)) : 0,         // um passeio pago a cada 2 dias
  });
  const total = (n) => Object.values(parts(n)).reduce((a, b) => a + b, 0);
  document.querySelectorAll("#days-pick button").forEach((b) => {
    const n = Number(b.dataset.n), on = n === days;
    b.className = `pressable ${on ? "bg-brand shadow-float" : "card"}`;
    b.innerHTML = `<p class="xs sb" style="opacity:${on ? .85 : 1};${on ? "" : "color:var(--muted-foreground)"}">${n} dias</p><p class="display xb" style="font-size:20px">${total(n) ? brl(total(n)) : "–"}</p><p class="tiny" style="opacity:.8;${on ? "" : "color:var(--muted-foreground)"}">por pessoa</p>`;
  });
  const v = parts(days), sum = total(days) || 1;
  const row = (label, val, note, missing) => `<div class="cost-row"><div class="row between sm"><span>${label} <span class="tiny muted">${note}</span></span><b>${val ? brl(val) : missing}</b></div><div class="cost-bar"><i style="width:${(val / sum) * 100}%"></i></div></div>`;
  const nome = encodeURIComponent(c.dest.name);
  document.getElementById("breakdown").innerHTML = `<h3 class="b" style="margin-bottom:8px">Composição para ${days} dias, por pessoa</h3>
    ${row("✈️ Passagem ida e volta", v.flight, c.flight ? "preço real" : "", `<a class="primary-t" href="#/nova?dest=${esc(c.dest.code)}&nome=${nome}">vigiar preço</a>`)}
    ${row(`🏨 Hospedagem · ${days} noites`, v.stay, c.hotelNight ? "suas buscas" : k ? "estimativa" : "", `<a class="primary-t" href="#/hospedagem?d=${esc(c.dest.code)}&nome=${nome}">comparar hotéis</a>`)}
    ${row("🍽️ Alimentação", v.food, k ? "estimativa" : "", "–")}
    ${row("🚇 Transporte local", v.transport, k ? "estimativa" : "", "–")}
    ${row(`🎟️ Passeios · ${Math.max(1, Math.round(days / 2))}`, v.fun, c.tourAvg ? "preço médio real" : "", "–")}
    <p class="xs muted" style="padding-top:8px">Por pessoa, com quarto duplo dividido por 2. Passagem e passeios com preços reais; hospedagem real quando você já buscou hotéis aqui${k ? ", senão estimada" : ""}; comida e transporte ${k ? "estimados pela IA para esta cidade" : "ainda sem estimativa (o robô calcula em breve)"}.</p>`;
}

function openLightbox(start) {
  const { images, caps } = S.current;
  const el = document.createElement("div");
  el.className = "lightbox";
  el.innerHTML = `<div class="lightbox-track">${images.map((src, i) => `<div><img src="${esc(src)}" alt="" loading="lazy"><p>${esc(caps[i] || "")}</p></div>`).join("")}</div><p style="padding-bottom:32px">Deslize para ver mais · toque fora para fechar</p>`;
  el.addEventListener("click", (e) => { if (e.target.tagName !== "IMG") el.remove(); });
  document.body.appendChild(el);
  const track = el.querySelector(".lightbox-track");
  track.scrollLeft = track.clientWidth * start;
}

const wmo = (c) => (c === 0 ? "☀️" : c <= 2 ? "🌤️" : c === 3 ? "☁️" : c <= 48 ? "🌫️" : c <= 67 ? "🌧️" : c <= 77 ? "❄️" : c <= 82 ? "🌦️" : "⛈️");

function entryRules(cc) {
  if (cc === "BR") return { tag: "Só documento com foto", text: "Viagem nacional: leve um documento oficial com foto." };
  if (SCHENGEN.includes(cc)) return { tag: "Schengen: 90 dias", text: "Brasileiro não precisa de visto para turismo: até 90 dias a cada 180 no Espaço Schengen. Leve passaporte válido, seguro-viagem e comprovantes de hospedagem e volta. Confira se a autorização ETIAS já está sendo exigida." };
  if (RG_COUNTRIES.includes(cc)) return { tag: "Entra com RG", text: "Dá para entrar só com o RG (carteira de identidade) em bom estado, de preferência emitido há menos de 10 anos, ou com passaporte." };
  if (cc === "US") return { tag: "Exige visto", text: "Exige visto americano (turismo B1/B2) e passaporte válido." };
  if (cc === "GB") return { tag: "ETA obrigatória", text: "Não precisa de visto para turismo, mas exige a autorização eletrônica ETA antes do embarque." };
  if (cc === "CA") return { tag: "Visto ou eTA", text: "Exige visto ou autorização eletrônica eTA (para quem tem ou teve visto americano nos últimos 10 anos)." };
  return { tag: null, text: "Confira no Portal Consular se é preciso visto e quais documentos levar." };
}

const PLUG_TYPES = { "Europlug": "C", "Schuko": "F", "CEE 7/5": "E", "AS/NZS 3112": "I", "IEC 60906-1": "N", "NEMA 1-15": "A", "NEMA 5-15": "B", "BS 1363": "G", "BS 546": "D", "CEI 23-50": "L", "SEV 1011": "J", "SI 32": "H" };
function plugInfo(f) {
  const types = [...new Set((f?.plugs || []).map((p) => PLUG_TYPES[p] || (p.match(/\b(?:Type|tipo)\s+([A-N])\b/i) || [])[1]).filter(Boolean))].sort();
  if (!types.length) return null;
  return { text: `Tipo${types.length > 1 ? "s" : ""} ${types.join(" e ")}${f.voltage ? ` · ${f.voltage}V` : ""}`, adapter: !types.some((t) => t === "C" || t === "N") };
}

function tipsFor(d, plugs, attractions) {
  const f = d.facts || {};
  const tips = [];
  if (attractions[0]) tips.push(`O mais famoso por aqui é ${attractions[0].name}: vá cedo ou compre o ingresso antes para fugir das filas.`);
  if (plugs?.adapter) tips.push(`Leve adaptador de tomada (${plugs.text.split(" · ")[0].toLowerCase()}).`);
  if (f.currency && f.currency !== "BRL") tips.push("Cartões de contas globais (Wise, Nomad, Inter) costumam sair mais baratos que o cartão de crédito comum, que cobra IOF de 3,5% e câmbio do dia.");
  if (SCHENGEN.includes(d.country_code)) tips.push("Seguro-viagem com cobertura mínima de €30 mil é obrigatório no Espaço Schengen.");
  if (d.country_code === "BR") tips.push("Voos nacionais costumam ficar mais baratos comprando de 1 a 3 meses antes.");
  else tips.push("Passagens internacionais costumam ter os melhores preços de 2 a 6 meses antes: deixe o robô vigiar.");
  tips.push("Confira a previsão da semana antes de fazer a mala.");
  return tips.slice(0, 5);
}
