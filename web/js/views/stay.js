// Hospedagem: busca de hotéis/hostels (o robô compara os sites no Google Hotels) e o resultado.
import { sb, S, q, favBtn, esc, brl, ago, fmtShort, fmtDay, todayIso, addDays, daysBetween, toast, friendlyError, place, photo, bg, loadDestinations } from "../core.js";
import { icon } from "../icons.js";
import { pill, seg, bindSeg, secTitle, stayRange, autocomplete, back } from "../ui.js";

const SITES = ["Booking", "Expedia", "Hoteis.com", "Decolar", "Agoda", "Hostelworld"];

export async function viewStay() {
  const [routes, recent] = await Promise.all([
    q(sb.from("routes").select("*").eq("active", true).order("created_at")),
    q(sb.from("hotel_searches").select("id,city_code,city_name,checkin,checkout,adults,kind,stars,status,created_at,results").order("created_at", { ascending: false }).limit(8)).catch(() => []),
  ]);
  const dests = await loadDestinations([...routes.map((r) => r.destination), ...recent.map((h) => h.city_code)]);
  // destinos para escolher: suas rotas, buscas recentes e o que veio no endereço
  const opts = new Map();
  for (const r of routes) opts.set(r.destination, dests[r.destination]?.name || place(r, "destination"));
  for (const h of recent) if (h.city_code && !opts.has(h.city_code)) opts.set(h.city_code, h.city_name);
  const p = S.params;
  let code = p.get("d") || [...opts.keys()][0] || null;
  if (code && !opts.has(code)) opts.set(code, p.get("nome") || code);
  const route = routes.find((r) => r.destination === code);
  let [de, ate] = route ? stayRange(route) : [null, null];
  de = p.get("de") || de; ate = p.get("ate") || ate;
  const ci = de && de > todayIso() ? de : addDays(todayIso(), 30);
  const co = ate && ate > ci && daysBetween(ci, ate) <= 30 ? ate : addDays(ci, 7);
  const adults = Math.max(1, Math.min(8, Number(p.get("adultos")) || route?.adults || 2));
  S.current = { stay: { code, name: opts.get(code), adults, kind: "hotel", stars: null, opts } };

  return `<main class="page">
    <div class="page-title"><h1>Hospedagem</h1><p>Um hotel, todos os sites: veja onde está mais barato.</p></div>
    <form class="card pad stack" id="hotel-form" novalidate>
      <label class="field"><span>Destino</span><select class="input" name="dest" id="dest-select">
        ${[...opts].map(([c, n]) => `<option value="${esc(c)}" ${c === code ? "selected" : ""}>${esc(n)}</option>`).join("")}
        <option value="__other">🔎 Outra cidade…</option></select></label>
      <div class="ac" id="other-city" hidden><input class="input" type="text" autocomplete="off" placeholder="Digite a cidade (ex.: Lisboa)"><div class="ac-list" hidden></div></div>
      <div class="grid2" style="gap:8px">
        <label class="field"><span>Check-in</span><input class="input" type="date" name="checkin" min="${addDays(todayIso(), 1)}" value="${ci}"></label>
        <label class="field"><span>Check-out</span><input class="input" type="date" name="checkout" min="${addDays(todayIso(), 1)}" value="${co}"></label>
      </div>
      <div class="row between"><span class="sm" style="font-weight:500">Hóspedes</span>
        <div class="stepper"><button type="button" data-step="-1" aria-label="Menos">${icon("minus", 18)}</button><output id="guests">${adults}</output><button type="button" class="plus" data-step="1" aria-label="Mais">${icon("plus", 18)}</button></div></div>
      ${seg("kind-seg", [["hotel", "🏨 Hotéis"], ["hostel", "🛏️ Hostels"]], "hotel")}
      <div id="stars-field"><p class="xs sb muted" style="margin-bottom:6px">Estrelas</p>${seg("stars-seg", [["", "Qualquer"], ["2", "2★"], ["3", "3★"], ["4", "4★"], ["5", "5★"]], "")}</div>
      <div id="hotel-msg"></div>
      <button class="btn big block bg-brand shadow-float pressable" type="submit" style="font-size:16px">${icon("search", 20)} Comparar preços nos sites</button>
      <div class="site-pills">${SITES.map((s) => pill(s)).join("")}</div>
    </form>

    ${routes.length ? `${secTitle("Para as suas viagens")}
      <div class="scroller">${routes.filter((r, i, a) => a.findIndex((x) => x.destination === r.destination) === i).map((r) => {
        const [a, b] = stayRange(r);
        const d = dests[r.destination];
        const q2 = new URLSearchParams({ d: r.destination, nome: d?.name || place(r, "destination"), de: a, ate: b, adultos: String(r.adults) });
        return `<a class="card trip-card pressable" href="#/hospedagem?${q2}"><span class="ph" style="display:block;height:112px;background:var(--gradient-brand) center/cover" ${bg(photo(d, 500))}></span>
          <div class="pad-s"><p class="b truncate">${esc(d?.name || place(r, "destination"))}</p><p class="xs muted truncate">${fmtShort(a)} → ${fmtShort(b)} · ${r.adults} hóspede${r.adults > 1 ? "s" : ""}</p>
          <p class="xs sb primary-t" style="margin-top:4px">Comparar hotéis nessas datas →</p></div></a>`;
      }).join("")}</div>` : ""}

    ${recent.length ? `${secTitle("Suas buscas recentes")}
      <div>${recent.map((h, i) => {
        const best = (h.results || []).flatMap((x) => (x.offers || []).map((o) => ({ ...o, hotel: x.name }))).filter((o) => o.night).sort((a, b) => a.night - b.night)[0];
        const d = dests[h.city_code];
        return `<a class="card pad-s pressable row" style="gap:12px;margin-top:${i ? 12 : 0}px" href="#/hoteis/${h.id}">
          <span class="emoji-tile" ${bg(photo(d, 330))}>${photo(d, 330) ? "" : "🏨"}</span>
          <span class="grow"><p class="b truncate">${h.kind === "hostel" ? "Hostels" : "Hotéis"} em ${esc(h.city_name)}${h.stars ? ` · ${h.stars}★` : ""}</p>
            <p class="xs muted truncate">${fmtShort(h.checkin)} → ${fmtShort(h.checkout)} · ${h.adults} hóspede${h.adults > 1 ? "s" : ""} · ${ago(h.created_at)}</p></span>
          <span style="text-align:right">${h.status === "done" ? (best ? `<p class="display xb good-t">${brl(best.night)}</p><p class="tiny muted">no ${esc(best.provider)}</p>` : pill("pronta", "good")) : h.status === "error" ? pill("falhou", "bad") : pill("buscando…", "primary")}</span>
        </a>`;
      }).join("")}</div>` : ""}
  </main>`;
}

viewStay.after = () => {
  const st = S.current.stay;
  const form = document.getElementById("hotel-form");
  if (!form) return;
  const f = (n) => form.elements.namedItem(n);
  const msg = document.getElementById("hotel-msg");
  const check = () => {
    const nights = daysBetween(f("checkin").value, f("checkout").value);
    const err = !f("checkin").value || f("checkin").value <= todayIso() ? "O check-in precisa ser a partir de amanhã."
      : nights <= 0 ? "O check-out precisa ser depois do check-in." : nights > 30 ? "Máximo de 30 noites por busca." : !st.code ? "Escolha o destino." : "";
    msg.innerHTML = err ? `<div class="hint bad">${esc(err)}</div>` : `<p class="xs muted center">${nights} noite${nights > 1 ? "s" : ""} · ${st.adults} hóspede${st.adults > 1 ? "s" : ""}</p>`;
    form.querySelector("[type=submit]").disabled = !!err;
    return !err;
  };
  const other = document.getElementById("other-city");
  f("dest").addEventListener("change", () => {
    const v = f("dest").value;
    other.hidden = v !== "__other";
    if (v === "__other") { st.code = null; other.querySelector("input").focus(); }
    else { st.code = v; st.name = st.opts.get(v); }
    check();
  });
  autocomplete(other.querySelector("input"), other.querySelector(".ac-list"), (it) => {
    st.code = it.cityCode; st.name = it.label;
    other.querySelector("input").value = `${it.label} (${it.cityCode})`;
    check();
  }, ["city"]);
  f("checkin").addEventListener("change", () => { if (f("checkout").value <= f("checkin").value) f("checkout").value = addDays(f("checkin").value, 7); check(); });
  f("checkout").addEventListener("change", check);
  form.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    st.adults = Math.min(8, Math.max(1, st.adults + Number(b.dataset.step)));
    document.getElementById("guests").textContent = st.adults; check();
  }));
  bindSeg("kind-seg", (v) => { st.kind = v; document.getElementById("stars-field").hidden = v === "hostel"; });
  bindSeg("stars-seg", (v) => { st.stars = v ? Number(v) : null; });
  check();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!check()) return;
    const row = { city_code: st.code, city_name: st.name, checkin: f("checkin").value, checkout: f("checkout").value, adults: st.adults, kind: st.kind, stars: st.kind === "hotel" ? st.stars : null };
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      // mesma busca nas últimas 6 h: reaproveita
      const cached = await q(sb.from("hotel_searches").select("id").eq("city_name", row.city_name).eq("checkin", row.checkin).eq("checkout", row.checkout)
        .eq("adults", row.adults).eq("kind", row.kind)[row.stars ? "eq" : "is"]("stars", row.stars).eq("status", "done")
        .gte("created_at", new Date(Date.now() - 6 * 3600000).toISOString()).order("created_at", { ascending: false }).limit(1));
      const id = cached[0]?.id || (await q(sb.from("hotel_searches").insert(row).select("id").single())).id;
      location.hash = `#/hoteis/${id}`;
    } catch (err) { msg.innerHTML = `<div class="hint bad">${esc(friendlyError(err))}</div>`; btn.disabled = false; }
  });
};

// ---------------------------------------------------------------------------
// Resultado (o robô preenche hotel a hotel; a tela atualiza sozinha)
// ---------------------------------------------------------------------------
let sort = "rec";

export async function viewHotels(id) {
  const row = await q(sb.from("hotel_searches").select("*").eq("id", id).maybeSingle());
  if (!row) return `<main class="page">${back("#/hospedagem", "Hospedagem")}<div class="card pad">Busca não encontrada.</div></main>`;
  S.current = { hotelSearch: row, expanded: new Set() };
  const nights = daysBetween(row.checkin, row.checkout);
  return `<main class="page">
    ${back("#/hospedagem", "Hospedagem")}
    <div class="page-title"><h1>${row.kind === "hostel" ? "Hostels" : "Hotéis"} em ${esc(row.city_name)}</h1>
      <p>${fmtShort(row.checkin)} → ${fmtShort(row.checkout)} · ${nights} noite${nights > 1 ? "s" : ""} · ${row.adults} hóspede${row.adults > 1 ? "s" : ""}${row.stars ? ` · ${row.stars} estrelas` : ""}</p></div>
    ${seg("hotel-sort", [["rec", "Recomendados"], ["price", "Menor preço"], ["rating", "Melhor nota"]], sort)}
    <div id="hotels-body"></div>
  </main>`;
}
viewHotels.after = (id) => {
  const myHash = location.hash;
  const paint = () => { const el = document.getElementById("hotels-body"); if (el) el.innerHTML = hotelsBody(S.current.hotelSearch); };
  bindSeg("hotel-sort", (v) => { sort = v; paint(); });
  document.getElementById("hotels-body")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-more]"); if (!b) return;
    S.current.expanded.add(b.dataset.more); paint();
  });
  paint();
  const started = Date.now();
  const timer = setInterval(async () => {
    if (location.hash !== myHash) return clearInterval(timer);
    try {
      const row = await q(sb.from("hotel_searches").select("*").eq("id", id).maybeSingle());
      if (location.hash !== myHash) return clearInterval(timer);
      S.current.hotelSearch = row;
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
    return waiting ? `<div class="card pad"><p class="sm sb">🔎 Procurando hotéis e comparando os sites…</p><p class="xs muted" style="margin-top:4px">Leva cerca de 1 minuto. Pode deixar esta tela aberta.</p><div class="progress"><i style="width:8%"></i></div></div>`
      : `<div class="card pad center sm muted">Nenhum hotel encontrado para essas datas.</div>`;
  }
  const minNight = (h) => Math.min(...(h.offers || []).map((o) => o.night ?? Infinity), h.night ?? Infinity);
  if (sort === "price") hotels.sort((a, b) => minNight(a) - minNight(b));
  if (sort === "rating") hotels.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const ready = hotels.filter((h) => h.offers != null).length;
  return `${waiting ? `<div class="card pad"><p class="sm sb">Comparando os sites… ${ready} de ${hotels.length} hotéis prontos</p><div class="progress"><i style="width:${Math.max(8, (ready / hotels.length) * 100)}%"></i></div></div>` : ""}
    ${hotels.map((h, i) => hotelCard(h, i, daysBetween(row.checkin, row.checkout))).join("")}
    <p class="xs muted">Preços do Google Hotels em reais, com taxas quando o site informa. Confira o valor final no site antes de reservar.</p>`;
}

function hotelCard(h, i, nights) {
  const offers = [...(h.offers || [])].sort((a, b) => (a.night ?? Infinity) - (b.night ?? Infinity));
  const key = h.name;
  const show = S.current.expanded.has(key) ? offers : offers.slice(0, 3);
  const min = offers.length ? offers[0].night : h.night;
  const row = (o, k) => `<div class="offer ${k === 0 ? "best" : ""}">
      <span class="grow sm sb truncate">${esc(o.provider)}${k === 0 && offers.length > 1 ? ` ${pill("mais barato", "good plain")}` : ""}</span>
      <span class="xs" style="text-align:right"><b class="sm">${brl(o.night)}</b><br><span class="muted">${o.total != null ? brl(o.total) : brl((o.night || 0) * nights)}</span></span>
      ${o.link ? `<a class="reserve pressable" href="${esc(o.link)}" target="_blank" rel="noopener">Reservar ↗</a>` : ""}
    </div>`;
  return `<article class="card hotel fade-up" style="animation-delay:${i * 60}ms">
    <div class="hotel-photo"><span class="ph" ${bg(h.image)}></span><span class="bg-fade"></span>
      ${favBtn("hotel", `${h.name}|${S.current.hotelSearch.city_name}`, { title: h.name, subtitle: `${S.current.hotelSearch.city_name}${h.stars ? ` · ${h.stars}★` : ""}${min ? ` · a partir de ${brl(min)}/noite` : ""}`, photo: h.image, link: h.page || "" }, "over")}
      ${h.stars ? `<span class="stars">${Array.from({ length: h.stars }, () => icon("star", 16)).join("")}</span>` : ""}</div>
    <div class="hotel-body">
      <div><h3 class="lg b">${esc(h.name)}</h3><p class="xs muted">${h.rating ? `⭐ ${Number(h.rating).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}/5` : ""}${h.reviews ? ` · ${Number(h.reviews).toLocaleString("pt-BR")} avaliações` : ""}</p></div>
      <p class="sm">a partir de <b class="display primary-t" style="font-size:20px">${brl(min)}</b>/noite${min ? ` · ${brl(h.total || min * nights)} no total` : ""}</p>
      <div>${h.offers == null ? `<p class="sm muted">⏳ comparando os sites…</p>` : !offers.length ? `<p class="sm muted">Sem preços por site para essas datas.</p>` : show.map(row).join("")}</div>
      <div class="hotel-links">
        ${offers.length > 3 && !S.current.expanded.has(key) ? `<button type="button" data-more="${esc(key)}">ver mais ${offers.length - 3} site${offers.length - 3 > 1 ? "s" : ""}</button>` : ""}
        ${h.page ? `<a href="${esc(h.page)}" target="_blank" rel="noopener">Ver no Google Hotels ↗</a>` : ""}
        ${h.lat ? `<a href="https://www.google.com/maps/search/?api=1&query=${h.lat},${h.lng}" target="_blank" rel="noopener">Mapa ↗</a>` : ""}
      </div>
    </div>
  </article>`;
}
