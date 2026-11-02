// Guia Local 📸: foto (câmera ou galeria) ou nome de um lugar → a história contada como um guia da cidade,
// com voz. Quem reconhece e escreve é a função guia-local do Supabase (fatos da Wikipédia + Gemini).
import { sb, S, q, esc, toast, friendlyError, favBtn, bg, ago } from "../core.js";
import { icon } from "../icons.js";
import { secTitle } from "../ui.js";

export const LOCAL_NAME = "Guia Local"; // nome provisório
const STEPS = ["📍 Vendo onde você está…", "👀 Reconhecendo o lugar…", "📚 Buscando a história…", "✍️ Preparando a explicação…", "📸 Separando as fotos…"];

// localização do celular (pedida uma vez por visita à tela) e o último pedido, para "Não é esse?"
const lstate = { pos: null, label: "", status: "idle", result: null, last: null, notFound: null };

function locate() {
  if (!navigator.geolocation) return Promise.resolve(null);
  if (lstate.pos && Date.now() - lstate.pos.at < 120000) return Promise.resolve(lstate.pos);
  return new Promise((ok) => navigator.geolocation.getCurrentPosition(
    (p) => { lstate.pos = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }; ok(lstate.pos); },
    () => ok(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }));
}

async function placeName(lat, lon) {
  try {
    const j = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=pt-BR&lat=${lat}&lon=${lon}`)).json();
    const a = j.address || {};
    return [a.neighbourhood || a.suburb || a.quarter || a.city_district, a.city || a.town || a.village].filter(Boolean).join(", ");
  } catch { return ""; }
}

// pontos da Wikipédia perto de um lugar
export async function nearbyPlaces(lat, lon, radius = 1500, limit = 30) {
  const p = new URLSearchParams({ origin: "*", format: "json", formatversion: "2", action: "query", generator: "geosearch", ggscoord: `${lat}|${lon}`,
    ggsradius: String(radius), ggslimit: String(limit), prop: "coordinates|pageimages|description", piprop: "thumbnail", pithumbsize: "500" });
  try {
    const j = await (await fetch(`https://pt.wikipedia.org/w/api.php?${p}`)).json();
    return (j.query?.pages || []).map((x) => ({ title: x.title, desc: x.description || "", thumb: x.thumbnail?.source || null,
      dist: x.coordinates?.[0] ? distM(lat, lon, x.coordinates[0].lat, x.coordinates[0].lon) : null }))
      .sort((a, b) => (!!b.thumb - !!a.thumb) || (a.dist ?? 1e9) - (b.dist ?? 1e9));
  } catch { return []; }
}
const distM = (a, b, c, d) => { const r = Math.PI / 180, h = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return Math.round(12742000 * Math.asin(Math.sqrt(h))); };
const fmtDist = (m) => (m == null ? "" : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`);

// foto reduzida (a IA não precisa de mais que 1024 px) e GPS da própria foto, se tiver
async function shrink(file) {
  const img = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => new Promise((ok, no) => {
    const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file);
  }));
  const k = Math.min(1, 1024 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.82);
  return { url, data: url.split(",")[1] };
}
async function photoGps(file) {
  try {
    const exifr = await import("https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.mjs");
    const g = await exifr.gps(file);
    return g?.latitude ? { lat: g.latitude, lon: g.longitude } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Chama o guia (tela de espera por cima de tudo)
// ---------------------------------------------------------------------------
async function runGuide(payload, preview = "") {
  const ov = document.createElement("div");
  ov.className = "lg-wait";
  ov.innerHTML = `<div class="lg-wait-card card">${preview ? `<span class="lg-wait-photo" ${bg(preview)}></span>` : `<span class="lg-wait-photo lg-wait-ic">${icon("compass", 40)}</span>`}
    <span class="spinner"></span><p class="b" data-step>${STEPS[payload.image ? 0 : 1]}</p><p class="xs muted">Leva alguns segundos</p></div>`;
  document.body.append(ov);
  let i = payload.image ? 0 : 1;
  const tick = setInterval(() => { i = Math.min(STEPS.length - 1, i + 1); ov.querySelector("[data-step]").textContent = STEPS[i]; }, 2600);
  const { image, ...rest } = payload;
  lstate.last = rest;
  try {
    const { data, error } = await sb.functions.invoke("guia-local", { body: payload });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    if (data.error) throw new Error(data.error);
    if (!data.found) {
      lstate.notFound = data;
      if (location.hash === "#/local") drawNotFound(); else location.hash = "#/local";
      return;
    }
    lstate.result = data;
    location.hash = `#/lugar/${encodeURIComponent(data.key)}`;
  } catch (e) {
    toast(/Failed to send|Failed to fetch/i.test(e.message) ? "O guia ainda não está no ar ou você está sem internet." : friendlyError(e), 6000);
  } finally { clearInterval(tick); ov.remove(); }
}

const withLoc = (extra) => ({ ...extra, ...(lstate.pos ? { lat: lstate.pos.lat, lon: lstate.pos.lon, accuracy: lstate.pos.accuracy } : {}) });

function drawNotFound() {
  const el = document.getElementById("lg-notfound");
  const d = lstate.notFound;
  if (!el || !d) return;
  lstate.notFound = null;
  el.innerHTML = `<section class="card pad fade-up"><h3 class="b">🤔 Não consegui reconhecer esse lugar</h3>
    ${d.what_i_see ? `<p class="sm muted" style="margin-top:4px">O que eu vi: ${esc(d.what_i_see)}</p>` : ""}
    ${d.alternatives?.length ? `<p class="sm sb" style="margin-top:10px">Pode ser um destes?</p><div class="city-chips" style="justify-content:flex-start">${d.alternatives.map((a) => `<button type="button" class="pressable" data-alt="${esc(a)}">${esc(a)}</button>`).join("")}</div>` : ""}
    <p class="xs muted" style="margin-top:10px">Dica: fotografe algo que identifique o lugar (fachada, placa, monumento) ou escreva o nome acima.</p></section>`;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

const nearCard = (p) => `<button type="button" class="related pressable lg-near" data-title="${esc(p.title)}">
  <span class="ph" ${bg(p.thumb)}>${p.thumb ? "" : `<span class="lg-near-ic">${icon("map-pin", 28)}</span>`}</span><span class="bg-fade"></span>
  ${p.dist != null ? `<span class="pill plain lg-near-dist">${fmtDist(p.dist)}</span>` : ""}<b>${esc(p.title)}</b></button>`;
const bindNear = (root) => root?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-title]");
  if (b) runGuide(withLoc({ title: b.dataset.title, lang: "pt" }));
});

// ---------------------------------------------------------------------------
// Tela inicial: câmera, galeria ou busca
// ---------------------------------------------------------------------------
export async function viewLocal() {
  const visits = await q(sb.from("local_visits").select("place_key,title,subtitle,photo,created_at").order("created_at", { ascending: false }).limit(40)).catch(() => []);
  const seen = new Set();
  const mine = visits.filter((v) => !seen.has(v.place_key) && seen.add(v.place_key)).slice(0, 8);
  return `<main class="page">
    <div class="page-title"><h1>📸 ${LOCAL_NAME}</h1><p>Passou por um lugar e ficou curioso? Tire uma foto ou escreva o nome, e eu conto a história como um guia da cidade.</p></div>
    <section class="card pad lg-capture">
      <div class="grid2">
        <label class="btn big bg-brand shadow-float pressable lg-shot">${icon("camera", 22)} Tirar foto<input type="file" accept="image/*" capture="environment" class="sr-file" id="lg-cam"></label>
        <label class="btn big cardbg pressable lg-shot">${icon("image", 22)} Da galeria<input type="file" accept="image/*" class="sr-file" id="lg-gal"></label>
      </div>
      <form class="search" id="lg-form" style="margin-top:12px">${icon("search", 20)}<input id="lg-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="Ou escreva: Escadaria Selarón, Templo Zu Lai…">
        <button class="clear" type="submit" aria-label="Buscar">${icon("arrow-right", 20)}</button></form>
      <button type="button" class="loc-chip" id="lg-loc">${icon("map-pin", 14)}<span>Ativando sua localização…</span></button>
    </section>
    <div id="lg-notfound"></div>
    <div id="lg-near"></div>
    ${mine.length ? `${secTitle("🗺️ Seus lugares")}
      <div class="card">${mine.map((v) => `<a class="row lg-visit" href="#/lugar/${encodeURIComponent(v.place_key)}"><span class="emoji-tile" ${bg(v.photo)}>${v.photo ? "" : "📍"}</span>
        <span class="grow"><p class="b truncate">${esc(v.title)}</p><p class="xs muted truncate">${esc(v.subtitle || "")} · ${ago(v.created_at)}</p></span>${icon("chevron-right", 18)}</a>`).join("")}</div>` : ""}
  </main>`;
}

viewLocal.after = async () => {
  drawNotFound();
  const onFile = async (input) => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const fromGallery = input.id === "lg-gal";
      const [img, gps] = await Promise.all([shrink(file), fromGallery ? photoGps(file) : null]);
      if (!gps && !fromGallery) await locate();
      const payload = gps ? { lat: gps.lat, lon: gps.lon, photoGps: true } : withLoc({});
      runGuide({ ...payload, image: img.data, mime: "image/jpeg" }, img.url);
    } catch (e) { console.error(e); toast("Não consegui abrir essa foto. Tente outra."); }
  };
  ["lg-cam", "lg-gal"].forEach((id) => document.getElementById(id).addEventListener("change", (e) => onFile(e.target)));
  document.getElementById("lg-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = document.getElementById("lg-q").value.trim();
    if (text.length < 3) return toast("Escreva o nome do lugar.");
    document.getElementById("lg-q").blur();
    runGuide(withLoc({ query: text }));
  });
  document.getElementById("lg-notfound").addEventListener("click", (e) => {
    const b = e.target.closest("[data-alt]");
    if (b) runGuide(withLoc({ query: b.dataset.alt }));
  });

  // localização: mostra o bairro e os pontos por perto
  const chip = document.getElementById("lg-loc");
  const find = async () => {
    chip.querySelector("span").textContent = "Ativando sua localização…";
    const pos = await locate();
    if (!document.body.contains(chip)) return;
    if (!pos) { chip.classList.add("off"); chip.querySelector("span").textContent = "Sem localização · toque para tentar de novo"; return; }
    chip.classList.remove("off");
    lstate.label = lstate.label || await placeName(pos.lat, pos.lon);
    chip.querySelector("span").textContent = lstate.label ? `Você está em ${lstate.label}` : "Localização ativada";
    const near = await nearbyPlaces(pos.lat, pos.lon, 1500, 20);
    const el = document.getElementById("lg-near");
    if (!el || !near.length) return;
    el.innerHTML = `${secTitle("📍 Perto de você", `<a class="xs sb primary-t" href="#/perto?lat=${pos.lat.toFixed(5)}&lon=${pos.lon.toFixed(5)}&nome=${encodeURIComponent(lstate.label || "você")}">Ver todos</a>`)}
      <div class="scroller">${near.slice(0, 10).map(nearCard).join("")}</div>`;
    bindNear(el);
  };
  chip.addEventListener("click", () => { lstate.pos = null; lstate.label = ""; find(); });
  find();
};

// ---------------------------------------------------------------------------
// O lugar: história, voz, o que reparar, fotos, curiosidades, dicas e "ver mais por perto"
// ---------------------------------------------------------------------------
export async function viewLocalPlace(raw) {
  const key = decodeURIComponent(raw);
  const fresh = lstate.result?.key === key ? lstate.result : null;
  const g = fresh || (await q(sb.from("local_places").select("data").eq("key", key).maybeSingle()).catch(() => null))?.data;
  if (!g) return `<main class="page"><a class="back" href="#/local">${icon("arrow-left", 16)} ${LOCAL_NAME}</a>
    <div class="card pad center"><p class="sm muted">Não achei esse lugar. Tente buscar de novo.</p></div></main>`;
  S.current = { place: g, fresh };
  S.ambient = g.photo?.url;
  const paras = String(g.story || "").split(/\n\s*\n/).filter(Boolean);
  const unsure = fresh && fresh.confidence < 0.6;
  const alts = (fresh?.alternatives || []).filter((a) => a && a.toLowerCase() !== g.title.toLowerCase());
  const map = g.place ? `https://www.google.com/maps/search/?api=1&query=${g.place.lat},${g.place.lon}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${g.title} ${g.subtitle || ""}`)}`;
  const link = `#/lugar/${encodeURIComponent(key)}`;
  const altChips = alts.length ? `<div class="city-chips" style="justify-content:flex-start;margin-top:8px">${alts.map((a) => `<button type="button" class="pressable" data-alt="${esc(a)}">${esc(a)}</button>`).join("")}</div>` : "";
  return `<div>
    <section class="lg-hero">
      <span class="ph" ${bg(g.photo?.url)}></span><span class="bg-fade"></span>
      <button type="button" class="gallery-back glass" onclick="history.length > 1 ? history.back() : (location.hash = '#/local')" aria-label="Voltar">${icon("arrow-left", 20)}</button>
      <div class="lg-hero-txt"><p class="sm sb">📍 ${esc(g.subtitle || "")}</p><h1 class="display xb">${esc(g.title)}</h1></div>
    </section>
    <main class="page">
      ${unsure ? `<div class="hint warn" style="font-size:13px">Acho que é este lugar, mas não tenho certeza.${alts.length ? " Pode ser também:" : ""}${altChips}</div>` : ""}
      ${g.sourced ? "" : `<div class="hint warn" style="font-size:13px">Não encontrei registros confiáveis sobre a história deste lugar. O texto abaixo descreve só o que dá para ver.</div>`}
      <div class="row" style="gap:8px">
        ${"speechSynthesis" in window ? `<button type="button" class="btn big bg-brand shadow-float pressable grow" id="lg-play">${icon("volume-2", 20)} Ouvir o guia</button>` : `<span class="grow"></span>`}
        ${favBtn("local", key, { title: g.title, subtitle: g.subtitle, photo: g.photo?.url || "", link }, "big")}
        <button class="card share-btn pressable" id="lg-share" aria-label="Compartilhar">${icon("share-2", 20)}</button>
      </div>
      <section class="card pad lg-story" id="lg-story">
        ${g.intro ? `<p class="lg-intro display b">${esc(g.intro)}</p>` : ""}
        ${paras.map((p) => `<p>${esc(p)}</p>`).join("")}
      </section>

      ${g.highlights?.length ? `${secTitle("👀 O que reparar aqui")}
        <div class="sights">${g.highlights.map((h, i) => `<article class="card sight">
          <div class="sight-photo" ${bg(h.photo?.url)}><b>${i + 1}</b>${h.photo ? "" : `<span class="lg-hl-ic">${icon("image", 26)}</span>`}</div>
          <div class="grow"><p class="b" style="line-height:1.25">${esc(h.name)}</p><p class="xs muted" style="margin-top:2px">${esc(h.desc)}</p>
            ${h.photo?.page ? `<a class="tiny muted" style="display:inline-block;margin-top:6px" href="${esc(h.photo.page)}" target="_blank" rel="noopener">Foto: ${esc(h.photo.credit || "Wikimedia Commons")} ↗</a>` : ""}</div>
        </article>`).join("")}</div>
        <p class="tiny muted">As fotos dos destaques vêm da Wikimedia Commons e podem não mostrar exatamente aquela parte.</p>` : ""}

      ${g.gallery?.length ? `${secTitle("📷 Mais fotos")}
        <div class="scroller">${g.gallery.map((p) => `<a class="related pressable" href="${esc(p.page || p.url)}" target="_blank" rel="noopener"><span class="ph" ${bg(p.url)}></span></a>`).join("")}</div>` : ""}

      ${g.curiosities?.length ? `<section class="tip" style="display:block"><h3 class="b">💡 Curiosidades</h3><ul class="sm" style="margin-top:8px">${g.curiosities.map((c) => `<li style="margin-top:6px">• ${esc(c)}</li>`).join("")}</ul></section>` : ""}
      ${g.tips?.length ? `<section class="card pad"><h3 class="b">🧭 Dicas do guia</h3><ul class="sm" style="margin-top:8px">${g.tips.map((t) => `<li style="margin-top:6px">• ${esc(t)}</li>`).join("")}</ul></section>` : ""}

      <div class="grid2">
        <a class="btn big cardbg pressable" style="font-size:15px" href="${map}" target="_blank" rel="noopener">${icon("map-pin", 18)} Ver no mapa</a>
        ${g.wiki ? `<a class="btn big cardbg pressable" style="font-size:15px" href="${esc(g.wiki.url)}" target="_blank" rel="noopener">📚 Wikipédia ↗</a>` : `<a class="btn big cardbg pressable" style="font-size:15px" href="#/local">${icon("camera", 18)} Outro lugar</a>`}
      </div>

      ${g.place ? `<div id="lg-more">${secTitle(`🗺️ Ver mais por perto`, `<a class="xs sb primary-t" href="#/perto?lat=${g.place.lat}&lon=${g.place.lon}&nome=${encodeURIComponent(g.title)}">Ver todos</a>`)}
        <div class="scroller" id="lg-more-list">${Array.from({ length: 3 }, () => `<div class="related skeleton"></div>`).join("")}</div></div>` : ""}

      ${!unsure && alts.length ? `<section class="card pad"><h3 class="b sm">Não era esse lugar?</h3>${altChips}</section>` : ""}
      <p class="tiny muted center">Texto escrito por IA${g.wiki ? " a partir da Wikipédia" : ""}. Confira informações importantes (horários, preços) antes de ir.</p>
    </main>
  </div>`;
}

viewLocalPlace.after = async () => {
  const g = S.current?.place;
  if (!g) return;
  document.querySelectorAll("[data-alt]").forEach((b) => b.addEventListener("click", () => runGuide({ ...(lstate.last || {}), title: undefined, query: b.dataset.alt })));
  document.getElementById("lg-share")?.addEventListener("click", async () => {
    const text = `${g.title}: ${g.intro || ""}`;
    try { if (navigator.share) await navigator.share({ title: g.title, text, url: location.href }); else { await navigator.clipboard.writeText(`${text}\n${location.href}`); toast("✅ Link copiado"); } } catch {}
  });
  const play = document.getElementById("lg-play");
  if (play) play.addEventListener("click", () => {
    if (voice.on) { stopVoice(); return; }
    const label = play.innerHTML;
    play.innerHTML = `${icon("square", 18)} Parar`;
    speak(g.spoken || [g.intro, g.story].filter(Boolean).join(" "), () => { if (document.body.contains(play)) play.innerHTML = label; });
  });
  if (g.place) {
    const near = (await nearbyPlaces(g.place.lat, g.place.lon, 2000, 20)).filter((p) => p.title !== g.wiki?.title && p.dist > 30);
    const el = document.getElementById("lg-more-list");
    if (!el) return;
    if (!near.length) { document.getElementById("lg-more").remove(); return; }
    el.innerHTML = near.slice(0, 10).map(nearCard).join("");
    bindNear(el);
  }
};

// ---------------------------------------------------------------------------
// Ver todos por perto
// ---------------------------------------------------------------------------
export async function viewLocalNearby() {
  const lat = Number(S.params.get("lat")), lon = Number(S.params.get("lon")), nome = S.params.get("nome") || "aqui";
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { location.replace("#/local"); return ""; }
  const list = await nearbyPlaces(lat, lon, 3000, 50);
  return `<main class="page">
    <a class="back" href="#/local">${icon("arrow-left", 16)} ${LOCAL_NAME}</a>
    <div class="page-title"><h1>Perto de ${esc(nome)}</h1><p>Toque num lugar e o guia conta a história dele.</p></div>
    ${list.length ? `<div class="gbento" id="lg-all">${list.map((p, i) => `<button type="button" class="photo-tile pressable fade-up ${i % 5 === 0 && p.thumb ? "big" : ""}" style="animation-delay:${Math.min(i, 12) * 40}ms;text-align:left;width:100%" data-title="${esc(p.title)}">
        <span class="ph" ${bg(p.thumb)}></span><span class="bg-fade"></span>
        ${p.dist != null ? `<span class="tr"><span class="pill plain">${fmtDist(p.dist)}</span></span>` : ""}
        <div class="bottom" style="display:block"><p class="display b" style="font-size:17px;line-height:1.2">${esc(p.title)}</p>${p.desc ? `<p class="xs truncate" style="opacity:.85">${esc(p.desc)}</p>` : ""}</div>
      </button>`).join("")}</div>` : `<div class="card pad center sm muted">Não achei pontos conhecidos por aqui.</div>`}
  </main>`;
}
viewLocalNearby.after = () => bindNear(document.getElementById("lg-all"));

// ---------------------------------------------------------------------------
// Voz: o próprio celular lê o texto (grátis). Fala frase por frase: textos longos travam em alguns aparelhos.
// ---------------------------------------------------------------------------
const voice = { on: false, done: null };
function bestVoice() {
  const all = speechSynthesis.getVoices();
  const pt = all.filter((v) => /^pt[-_]BR/i.test(v.lang));
  const pick = pt.find((v) => /premium|enhanced|aprimorad|natural|neural/i.test(v.name)) || pt.find((v) => /google|luciana|francisca|thalita|felipe|antonio/i.test(v.name)) || pt[0];
  return pick || all.find((v) => /^pt/i.test(v.lang)) || null;
}
function speak(text, done) {
  speechSynthesis.cancel();
  const parts = String(text).replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]+["”']?\s*|[^.!?…]+$/g) || [text];
  const v = bestVoice();
  Object.assign(voice, { on: true, done });
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    u.lang = "pt-BR"; u.rate = 1; if (v) u.voice = v;
    if (i === parts.length - 1) u.onend = () => stopVoice();
    u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") stopVoice(); };
    speechSynthesis.speak(u);
  });
}
function stopVoice() {
  if (!voice.on) return;
  voice.on = false;
  speechSynthesis.cancel();
  const d = voice.done; voice.done = null; d?.();
}
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener?.("voiceschanged", () => {});
  addEventListener("hashchange", stopVoice);
}
