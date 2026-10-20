// Rotas: lista, detalhe, cadastro/edição e Explorar promoções.
import { sb, S, q, cached, invalidate, esc, brl, ago, fmtDay, fmtShort, fmtDateTime, todayIso, addDays, daysBetween, isoDaysAgo, median, toast, friendlyError,
  place, stopsLabel, sourceLabel, photo, bg, loadDestinations, airlineName, pct } from "../core.js";
import { icon } from "../icons.js";
import { pill, seg, bindSeg, thermo, sparkline, changePill, verdictPill, verdictCard, buyVerdict, tripStart, countdownText, tripRange,
  longWindows, stayOk, stayRange, inScope, inScopeLong, lastCheck, cheapest, summary, priceFor, googleUrl, priceChart, calendarRange, autocomplete, back, secTitle } from "../ui.js";
import { loadRouteStats } from "../data.js";

// ---------------------------------------------------------------------------
// Lista de rotas
// ---------------------------------------------------------------------------
export async function viewRoutes() {
  const { stats } = await loadRouteStats();
  const active = stats.filter((s) => s.r.active).length;
  return `<main class="page">
    <div class="page-title"><h1>Suas rotas</h1><p>${active} de 10 ativas · o robô vigia 24 h por dia</p></div>
    ${!stats.length ? `<div class="card pad center"><div style="font-size:40px">✈️</div><p class="b">Nenhuma rota ainda</p><p class="sm muted" style="margin-top:4px">Toque em “Nova rota” para começar.</p></div>` : ""}
    <div class="stack" style="--gap:16px">${stats.map((s, i) => routeCard(s, i)).join("")}</div>
    <a class="fab bg-brand shadow-float pressable" href="#/nova">${icon("plus", 20)} Nova rota</a>
  </main>`;
}

function routeCard(s, i) {
  const { r, best } = s;
  const when = best ? (best.return_date ? `${fmtShort(best.depart_date)} → ${fmtShort(best.return_date)}` : fmtShort(best.depart_date)) : "";
  return `<a class="card route-card pressable fade-up ${r.active ? "" : "paused"}" style="animation-delay:${i * 60}ms;margin-top:${i ? 16 : 0}px" href="#/rota/${r.id}">
    <div class="route-photo"><span class="ph" ${bg(photo(s.dest, 500))}></span><span class="bg-fade"></span>
      <span class="tr">${!r.active ? pill("⏸ pausada") : countdownText(s.start) ? pill(`✈️ ${countdownText(s.start)}`, "lime") : ""}</span>
      <div class="bottom"><p class="display b lg truncate">${esc(place(r, "origin"))} → ${esc(place(r, "destination"))}</p><p class="xs truncate" style="opacity:.85">${esc(summary(r))}</p></div>
    </div>
    <div class="route-body">
      <div class="row between" style="align-items:flex-end;gap:12px">
        <div class="grow">
          <p class="xs muted">Menor preço${when && r.date_mode !== "fixed" ? ` em <b style="color:var(--foreground)">${esc(when)}</b>` : ""}</p>
          <p class="price-xl">${s.price != null ? brl(s.price) : "…"}</p>
          ${best ? `<p class="xs muted">${esc(priceFor(r, best).long)}${priceFor(r, best).each ? ` · ${brl(priceFor(r, best).each)} cada` : ""}</p>` : ""}
          <p class="xs muted">${best ? `normal ~${brl(s.normal)} · ${ago(best.checked_at)}` : r.active ? "aguardando a primeira verificação (~15 min)" : "rota pausada"}</p>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${best ? changePill(s.change) : ""}${sparkline(s.points.map((p) => p.y))}</div>
      </div>
      ${best ? thermo(s.price, s.normal) : ""}
      <div class="row between">${verdictPill(s.verdict) || "<span></span>"}<span class="muted">${icon("chevron-right", 20)}</span></div>
      ${r.last_error ? `<p class="error-line">${icon("triangle-alert", 14)} ${esc(r.last_error)}</p>` : ""}
    </div>
  </a>`;
}

// ---------------------------------------------------------------------------
// Detalhe da rota
// ---------------------------------------------------------------------------
export async function viewRoute(id) {
  const [route, latestAll, trend, alerts] = await Promise.all([
    q(sb.from("routes").select("*").eq("id", id).maybeSingle()),
    q(sb.from("route_latest").select("*").eq("route_id", id).is("leg", null).gte("depart_date", todayIso()).limit(1000)),
    q(sb.from("route_trend").select("checked_at,best_price,normal_price").eq("route_id", id).gte("checked_at", isoDaysAgo(30)).order("checked_at").limit(1000)),
    q(sb.from("alerts").select("*").eq("route_id", id).order("created_at", { ascending: false }).limit(15)),
  ]);
  if (!route) return `<main class="page">${back("#/rotas", "Rotas")}<div class="card pad">Rota não encontrada.</div></main>`;
  const dest = (await loadDestinations([route.destination]))[route.destination];
  const long = route.date_mode === "long";
  const cur = { route, series: "all", latest: latestAll.filter((x) => inScope(route, x)) };
  if (long) {
    const [legs, totals] = await Promise.all([
      q(sb.from("route_latest").select("*").eq("route_id", id).in("leg", ["out", "back"]).limit(1000)),
      q(sb.from("route_latest").select("*").eq("route_id", id).in("leg", ["rt", "combo"]).gte("checked_at", isoDaysAgo(2)).order("price").limit(500)),
    ]);
    Object.assign(cur, { legs, totals });
  }
  const monthMedian = median(cur.latest.map((x) => Number(x.price)));
  cur.normalOf = (row) => (row?.normal_price != null ? Number(row.normal_price) : route.date_mode === "month" ? monthMedian : null);
  S.current = cur;

  const points = trend.map((t) => ({ t: new Date(t.checked_at), y: Number(t.best_price) }));
  const low = points.length ? Math.min(...points.map((p) => p.y)) : null;
  let top, topNormal;
  if (long) {
    const ld = longData();
    top = [ld.combo, ld.rt].filter(Boolean).sort((a, b) => Number(a.price) - Number(b.price))[0] || null;
    topNormal = top?.normal_price != null ? Number(top.normal_price) : null;
  } else {
    top = cheapest(cur.latest);
    topNormal = cur.normalOf(top);
  }
  const start = tripStart(route, top);
  const verdict = top && route.active ? buyVerdict(top.price, topNormal, low, start) : null;
  const [from, to] = tripRange(route);
  const normalLine = median(trend.map((t) => Number(t.normal_price)).filter(Boolean)) || topNormal;
  const nextCheck = route.last_checked_at ? new Date(new Date(route.last_checked_at).getTime() + route.check_every_hours * 3600000) : null;
  const requested = route.check_requested_at && (!route.last_checked_at || route.check_requested_at > route.last_checked_at);
  const destName = dest?.name || place(route, "destination");
  const guideHref = `#/guide/${esc(route.destination)}?de=${from}&ate=${to}&adultos=${route.adults}`;
  const [sIn, sOut] = top?.depart_date && top?.return_date && daysBetween(top.depart_date, top.return_date) <= 30 ? [top.depart_date, top.return_date] : stayRange(route);
  const stayHref = `#/hospedagem?d=${esc(route.destination)}&nome=${encodeURIComponent(destName)}&de=${sIn}&ate=${sOut}&adultos=${route.adults}`;

  return `<main class="page">
    ${back("#/rotas", "Rotas")}
    <div class="rhero fade-up"><span class="ph" ${bg(photo(dest, 960))}></span><span class="bg-fade"></span>
      <span class="tr">${!route.active ? pill("⏸ pausada") : countdownText(start) ? pill(`✈️ ${countdownText(start)}`, "lime") : ""}</span>
      <div class="bottom"><h1>${esc(place(route, "origin"))} → ${esc(place(route, "destination"))}</h1><p class="sm" style="opacity:.85">${esc(summary(route))}</p></div>
    </div>
    ${route.last_error ? `<div class="hint bad">${icon("triangle-alert", 14)} ${esc(route.last_error)}</div>` : ""}
    <div class="grid2">
      <a class="card link-card pressable" href="${guideHref}">${icon("compass", 24)}<p class="b">Conhecer ${esc(destName)}</p><p class="xs muted">Clima nas suas datas, pontos turísticos, moeda…</p></a>
      <a class="card link-card pressable" href="${stayHref}">${icon("hotel", 24)}<p class="b">Comparar hotéis</p><p class="xs muted">Preço de cada hotel em vários sites</p></a>
    </div>
    ${verdictCard(verdict)}
    ${long ? `<section class="card pad stack" id="long-box">${longBody()}</section>` : priceSection(route, top, topNormal)}
    <section class="card pad"><div class="row between" style="margin-bottom:8px"><h3 class="b">Histórico de 30 dias</h3>${points.length ? pill(`mín. ${brl(low)}`, "good") : ""}</div>${priceChart(points, normalLine)}</section>
    <section class="card pad"><h3 class="b" style="margin-bottom:8px">Alertas desta rota</h3>
      ${alerts.length ? alerts.map((a) => `<div class="list-row"><div class="grow"><p><b>${brl(a.price)}</b><span class="xs muted"> · ${esc(a.return_date ? `${fmtShort(a.depart_date)} → ${fmtShort(a.return_date)}` : fmtShort(a.depart_date))}${a.leg ? ` · ${legLabel(a.leg)}` : ""}</span></p><p class="xs muted">${esc((a.reasons || []).join("; "))}</p></div><span class="xs muted">${ago(a.created_at)}</span></div>`).join("")
        : `<p class="sm muted">Nenhum alerta ainda. Você será avisado quando o preço cair ${route.threshold_pct}% abaixo do normal.</p>`}
    </section>
    <section class="card pad grid2 sm">
      <div class="infobox"><p class="k">Última verificação</p><p class="v">${route.last_checked_at ? ago(route.last_checked_at) : "ainda não"}</p></div>
      <div class="infobox"><p class="k">Intervalo</p><p class="v">a cada ${route.check_every_hours} h</p></div>
      <div class="infobox"><p class="k">Próxima</p><p class="v">${!route.active ? "pausada" : requested ? "em até ~15 min" : nextCheck ? fmtDateTime(nextCheck) : "em até ~15 min"}</p></div>
      <div class="infobox"><p class="k">Alerta quando</p><p class="v">${route.threshold_pct}% abaixo do normal${route.target_price ? ` ou &lt; ${brl(route.target_price)}` : ""}</p></div>
    </section>
    <div class="grid2" style="gap:8px">
      <button class="action primary pressable" id="act-check" ${route.active ? "" : "disabled"}>${icon("refresh-cw", 16)} Verificar agora</button>
      <a class="action pressable" href="#/editar/${route.id}">${icon("pencil", 16)} Editar</a>
      <button class="action pressable" id="act-toggle">${icon(route.active ? "pause" : "play", 16)} ${route.active ? "Pausar" : "Reativar"}</button>
      <button class="action danger pressable" id="act-delete">${icon("trash-2", 16)} <span>Apagar rota</span></button>
    </div>
    <a class="row sm sb muted" style="justify-content:center;padding-top:8px" href="#/explorar">Ver promoções saindo de ${esc(place(route, "origin"))} ${icon("chevron-right", 16)}</a>
  </main>`;
}

viewRoute.after = (id) => {
  const { route } = S.current;
  document.getElementById("act-check")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { await q(sb.from("routes").update({ check_requested_at: new Date().toISOString() }).eq("id", id)); invalidate("routes"); toast("✅ Verificação na fila: resultado em até ~15 min."); }
    catch (err) { toast(friendlyError(err)); }
  });
  document.getElementById("act-toggle").addEventListener("click", async () => {
    try {
      await q(sb.from("routes").update({ active: !route.active, check_requested_at: new Date().toISOString(), last_error: null }).eq("id", id));
      invalidate("routes");
      toast(route.active ? "Rota pausada" : "Rota reativada");
      dispatchEvent(new HashChangeEvent("hashchange"));
    } catch (err) { toast(friendlyError(err), 5000); }
  });
  const del = document.getElementById("act-delete");
  del.addEventListener("click", async () => {
    if (!del.dataset.confirm) { del.dataset.confirm = "1"; del.querySelector("span").textContent = "Toque de novo"; return; }
    try { await q(sb.from("routes").delete().eq("id", id)); invalidate("routes"); toast("Rota apagada"); location.hash = "#/rotas"; }
    catch (err) { toast(friendlyError(err)); }
  });
  bindSeg("series-seg", (v) => { S.current.series = v; document.getElementById("long-box").innerHTML = longBody(); bindLong(); });
  bindLong();
  bindCalendars();
};

const legLabel = (leg) => ({ out: "só ida", back: "só volta", rt: "ida e volta", combo: "2 passagens só de ida" }[leg] || "");

function priceSection(route, best, normal) {
  if (!best) return `<section class="card pad"><p class="sm muted">${route.active ? "Ainda sem preços. O robô verifica em até ~15 min depois de cadastrar." : "Rota pausada."}</p></section>`;
  const p = Math.round(((Number(best.price) - normal) / normal) * 100);
  const dates = best.return_date ? `${fmtShort(best.depart_date)} → ${fmtShort(best.return_date)}` : fmtShort(best.depart_date);
  const g = best.source === "google" && best.link ? best.link : googleUrl(route, best.depart_date, best.return_date);
  const cal = route.date_mode === "month" ? (() => {
    const first = route.month;
    const d = new Date(first.slice(0, 4), Number(first.slice(5, 7)), 0);
    const last = `${first.slice(0, 8)}${String(d.getDate()).padStart(2, "0")}`;
    return `<div style="padding-top:8px">${calendarRange(first, last, Object.fromEntries(S.current.latest.map((x) => [x.depart_date, x])), S.current.normalOf, best.depart_date)}<div id="day-detail">${calFoot(route, best)}</div></div>`;
  })() : "";
  return `<section class="card pad stack">
    <div class="row between" style="align-items:flex-start;gap:12px">
      <div><p class="sm muted">Menor preço agora</p><p class="price-2xl">${brl(best.price)}</p>
        <p class="xs muted">${esc(priceFor(route, best).long)}${priceFor(route, best).each ? ` · ${brl(priceFor(route, best).each)} por pessoa` : ""}</p></div>
      ${normal ? pill(`${p > 0 ? "+" : ""}${p}% vs normal`, p < 0 ? "good" : "bad") : pill("aprendendo")}
    </div>
    ${thermo(best.price, normal)}
    <div class="grid3 center xs">
      <div class="infobox"><p class="k">Datas</p><p class="v">${esc(dates)}</p></div>
      <div class="infobox"><p class="k">Companhia</p><p class="v truncate">${esc(best.airline || "–")}</p></div>
      <div class="infobox"><p class="k">Escalas</p><p class="v">${esc(stopsLabel(best.stops) || "–")}</p></div>
    </div>
    <div class="row" style="gap:8px">
      <a class="btn primary" style="flex:1" href="${esc(g)}" target="_blank" rel="noopener">Google Flights ↗</a>
      ${best.source === "aviasales" && best.link ? `<a class="btn" style="flex:1" href="${esc(best.link)}" target="_blank" rel="noopener">Aviasales ↗</a>` : ""}
    </div>
    ${cal}
  </section>`;
}

function calFoot(route, row, back = false) {
  const g = row.source === "google" && row.link ? row.link : googleUrl(route, row.depart_date, row.return_date, back);
  return `<div class="cal-foot"><div><p class="xs muted">${row.return_date ? `Ida em ${fmtShort(row.depart_date)} · volta ${fmtShort(row.return_date)}` : `${back ? "Volta" : "Ida"} em ${fmtShort(row.depart_date)}`}${row.airline ? ` · ${esc(row.airline)}` : ""}</p>
    <p class="display xb primary-t" style="font-size:20px">${brl(row.price)}</p></div>
    <a class="btn primary sm" href="${esc(g)}" target="_blank" rel="noopener">Google Flights ↗</a></div>`;
}

function bindCalendars() {
  document.querySelectorAll(".cal").forEach((cal) => cal.addEventListener("click", (e) => {
    const cell = e.target.closest(".day[data-d]"); if (!cell) return;
    const group = cal.dataset.g || "";
    document.querySelectorAll(`.cal[data-g="${group}"] .day.sel`).forEach((x) => x.classList.remove("sel"));
    cell.classList.add("sel");
    if (!group) {
      const row = S.current.latest.find((x) => x.depart_date === cell.dataset.d);
      if (row) document.getElementById("day-detail").innerHTML = calFoot(S.current.route, row);
      return;
    }
    document.getElementById(`detail-${group}`).innerHTML = longDayDetail(group, cell.dataset.d);
  }));
}
function bindLong() { /* calendários da viagem longa são religados junto com os outros */ bindCalendars(); }

// ---------------------------------------------------------------------------
// Viagem longa: melhor total + calendários de ida e de volta
// ---------------------------------------------------------------------------
function longData() {
  const { route, legs, totals, series } = S.current;
  const mine = (rows) => rows.filter((x) => !!x.direct_only === (series === "direct") && inScopeLong(route, x));
  const leg = (name) => {
    const rows = mine(legs.filter((x) => x.leg === name));
    const med = median(rows.map((x) => Number(x.price)));
    return { rows, byDay: Object.fromEntries(rows.map((x) => [x.depart_date, x])), normalOf: (row) => (row?.normal_price != null ? Number(row.normal_price) : med) };
  };
  const recent = lastCheck(mine(totals));
  return { out: leg("out"), back: leg("back"), combo: recent.find((x) => x.leg === "combo") || null, rt: cheapest(recent.filter((x) => x.leg === "rt")) };
}

function longBody() {
  const { route, series } = S.current;
  const d = longData();
  const w = longWindows(route);
  const options = [d.combo, d.rt].filter(Boolean).sort((a, b) => Number(a.price) - Number(b.price));
  const bestOf = (leg) => cheapest(leg.rows)?.depart_date;
  const comboBox = (row, isBest) => {
    const stay = daysBetween(row.depart_date, row.return_date);
    const links = row.leg === "combo"
      ? [["Ida no Google ↗", googleUrl(route, row.depart_date, null)], ["Volta no Google ↗", googleUrl(route, row.return_date, null, true)], ["Comparar com ida e volta ↗", googleUrl(route, row.depart_date, row.return_date)]]
      : [["Ver no Google Flights ↗", row.source === "google" && row.link ? row.link : googleUrl(route, row.depart_date, row.return_date)]];
    return `<div class="${isBest ? "best-box" : "soft-box"}">
      <div class="row between"><p class="sm sb">${row.leg === "combo" ? "Duas passagens só de ida" : "Ida e volta na mesma passagem"}</p>${isBest ? pill("melhor", "good") : ""}</div>
      <p class="price-xl">${brl(row.price)}</p>
      <p class="xs muted">${fmtShort(row.depart_date)} → ${fmtShort(row.return_date)} · ${stay} dias${row.airline ? ` · ${esc(row.airline)}` : ""}</p>
      <div class="row wrap" style="gap:8px;margin-top:12px">${links.map(([l, u]) => `<a class="btn cardbg sm" href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join("")}</div>
    </div>`;
  };
  return `<h3 class="b">Melhor total da viagem agora</h3>
    ${route.track_direct ? seg("series-seg", [["all", "Todos os voos"], ["direct", "Só diretos"]], series) : ""}
    ${route.trip_type === "round_trip" ? (options.length ? options.map((o, i) => comboBox(o, i === 0)).join("")
      : `<div class="soft-box"><p class="sm muted">Ainda montando: o robô precisa de preços de ida e de volta. Leva algumas rodadas (~15 min cada).</p></div>`) : ""}
    ${route.trip_type === "round_trip" && !d.rt ? `<div class="soft-box"><p class="sm sb">Ida e volta na mesma passagem</p><p class="sm muted">Estadia acima de 30 dias: compare manualmente pelo botão “Comparar com ida e volta”.</p></div>` : ""}
    <div class="grid2" style="grid-template-columns:1fr;gap:16px;padding-top:8px">
      <div><p class="eyebrow" style="margin-bottom:4px">Ida (só ida)</p>${w.outFrom <= w.outTo ? calendarRange(w.outFrom, w.outTo, d.out.byDay, d.out.normalOf, bestOf(d.out), "out") : `<p class="sm muted">As datas de ida já passaram.</p>`}<div id="detail-out"></div></div>
      ${w.backFrom ? `<div><p class="eyebrow" style="margin-bottom:4px">Volta (só volta)</p>${calendarRange(w.backFrom, w.backTo, d.back.byDay, d.back.normalOf, bestOf(d.back), "back")}<div id="detail-back"></div></div>` : ""}
    </div>`;
}

function longDayDetail(group, iso) {
  const { route } = S.current;
  const d = longData();
  const row = d[group].byDay[iso];
  if (!row) return "";
  let pair = "";
  if (route.trip_type === "round_trip") {
    const other = group === "out" ? d.back : d.out;
    const fits = other.rows.filter((x) => (group === "out" ? stayOk(route, iso, x.depart_date) : stayOk(route, x.depart_date, iso)));
    const best = cheapest(fits);
    if (best) {
      const [dep, ret] = group === "out" ? [iso, best.depart_date] : [best.depart_date, iso];
      pair = `<p class="xs muted" style="margin-top:6px">Melhor ${group === "out" ? "volta para esta ida" : "ida para esta volta"}: <b>${brl(best.price)}</b> em ${fmtShort(best.depart_date)} · total <b>${brl(Number(row.price) + Number(best.price))}</b> · ${daysBetween(dep, ret)} dias</p>`;
    }
  }
  return calFoot(route, row, group === "back") + pair;
}

// ---------------------------------------------------------------------------
// Nova rota / editar
// ---------------------------------------------------------------------------
let form = null;

export async function viewForm(id = null) {
  let r = null;
  if (id) {
    r = await q(sb.from("routes").select("*").eq("id", id).maybeSingle());
    if (!r) return `<main class="page">${back("#/rotas", "Rotas")}<div class="card pad">Rota não encontrada.</div></main>`;
  }
  const pre = id ? new URLSearchParams() : S.params;
  let nextMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; })();
  if (pre.get("mes")) nextMonth = pre.get("mes") + "-01";
  const nextMonthEnd = (() => { const d = new Date(nextMonth.slice(0, 4), Number(nextMonth.slice(5, 7)), 0); return `${nextMonth.slice(0, 8)}${String(d.getDate()).padStart(2, "0")}`; })();
  form = {
    id, original: r,
    origin: r ? { code: r.origin, label: r.origin_label || r.origin } : { code: pre.get("orig") || "RIO", label: pre.get("orignome") || "Rio de Janeiro" },
    destination: r ? { code: r.destination, label: r.destination_label || r.destination } : pre.get("dest") ? { code: pre.get("dest"), label: pre.get("nome") || pre.get("dest") } : null,
    trip_type: r?.trip_type || "round_trip",
    date_mode: r?.date_mode || (pre.get("mes") ? "month" : "month"),
    adults: r?.adults || 1,
    max_stops: r ? (r.max_stops == null ? "" : String(r.max_stops)) : "",
    every: r?.check_every_hours || 3,
  };
  const preStay = pre.get("dias") ? Math.max(1, Math.min(60, Number(pre.get("dias")))) : 7;
  const v = (x, d = "") => esc(x ?? d);
  const step = (n, title, body) => `<section class="card pad step fade-up" style="animation-delay:${n * 50}ms"><h3><b>${n}</b>${title}</h3>${body}</section>`;
  const placeInput = (name, ph) => `<div class="ac" data-place="${name}"><input class="input" type="text" autocomplete="off" autocapitalize="words" placeholder="${ph}" value="${form[name] ? esc(`${form[name].label} (${form[name].code})`) : ""}"><div class="ac-list" hidden></div></div>`;
  return `<main class="page">
    ${back(id ? `#/rota/${id}` : "#/rotas", id ? "Voltar" : "Rotas")}
    <div class="page-title"><h1>${id ? "Editar rota" : "Nova rota"}</h1></div>
    <form id="route-form" novalidate>
      ${step(1, "Para onde?", `<div style="position:relative">
        ${placeInput("origin", "Origem")}
        <div style="height:8px"></div>
        ${placeInput("destination", "Destino — cidade ou aeroporto")}
        <button type="button" id="swap" class="conv-swap shadow-float" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:10" aria-label="Inverter">${icon("arrow-up-down", 16)}</button>
      </div><p class="chosen" id="chosen"></p>`)}
      ${step(2, "Tipo de viagem", seg("seg-trip", [["round_trip", "Ida e volta"], ["one_way", "Só ida"]], form.trip_type))}
      ${step(3, "Datas", `${seg("seg-mode", [["fixed", "Data fixa"], ["month", "Mês inteiro"], ["long", "Viagem longa"]], form.date_mode)}
        <div data-show="fixed" class="grid2" style="gap:8px">
          <label class="field"><span>Ida</span><input class="input" type="date" name="depart_date" min="${todayIso()}" value="${v(r?.depart_date)}"></label>
          <label class="field" data-show="round_trip"><span>Volta</span><input class="input" type="date" name="return_date" min="${todayIso()}" value="${v(r?.return_date)}"></label>
        </div>
        <div data-show="month" class="grid2" style="gap:8px">
          <label class="field"><span>Mês da ida</span><input class="input" type="month" name="month" min="${todayIso().slice(0, 7)}" value="${v((r?.month || nextMonth).slice(0, 7))}"></label>
          <label class="field" data-show="round_trip"><span>Dias de viagem</span><input class="input" type="number" name="stay_days" min="1" max="60" inputmode="numeric" value="${v(r?.stay_days, preStay)}"></label>
        </div>
        <div data-show="long" class="stack">
          <div class="grid2" style="gap:8px">
            <label class="field"><span>Ida a partir de</span><input class="input" type="date" name="depart_from" min="${todayIso()}" value="${v(r?.depart_from || nextMonth)}"></label>
            <label class="field"><span>Ida até</span><input class="input" type="date" name="depart_to" min="${todayIso()}" value="${v(r?.depart_to || nextMonthEnd)}"></label>
          </div>
          <div class="grid2" style="gap:8px" data-show="round_trip">
            <label class="field"><span>Volta no mínimo (dias)</span><input class="input" type="number" name="min_stay" min="1" max="330" inputmode="numeric" value="${v(r?.min_stay, 60)}"></label>
            <label class="field"><span>No máximo (dias)</span><input class="input" type="number" name="max_stay" min="1" max="330" inputmode="numeric" value="${v(r?.max_stay, 89)}"></label>
          </div>
          <label class="check-row"><span>Acompanhar também só voos diretos</span><input type="checkbox" name="track_direct" ${r?.track_direct ? "checked" : ""}></label>
          <p class="hint warn">Lembrete: no Espaço Schengen o limite é de 90 dias a cada 180. O robô compara ida e volta com duas passagens só de ida.</p>
        </div>`)}
      ${step(4, "Passageiros e escalas", `<div class="row between"><span style="font-weight:500">Adultos</span>
          <div class="stepper"><button type="button" data-step="-1" aria-label="Menos">${icon("minus", 18)}</button><output id="adults">${form.adults}</output><button type="button" class="plus" data-step="1" aria-label="Mais">${icon("plus", 18)}</button></div></div>
        ${seg("seg-stops", [["", "Qualquer"], ["1", "Até 1"], ["0", "Só direto"]], form.max_stops)}`)}
      ${step(5, "Quando me avisar", `<div class="row between sm"><span>Preço ficar abaixo do normal em</span><b class="primary-t" id="thr-out">${r?.threshold_pct || 15}%</b></div>
        <input type="range" name="threshold_pct" min="5" max="40" step="1" value="${r?.threshold_pct || 15}">
        <label class="field"><span>Preço-alvo (opcional, total em R$)</span><input class="input" type="number" name="target_price" min="1" inputmode="numeric" placeholder="R$ 2.500" value="${v(r?.target_price)}"></label>
        <p class="xs sb muted" style="margin-bottom:-6px">Verificar a cada</p>
        <div class="chips-row" id="every">${[1, 2, 3, 6, 12].map((h) => `<button type="button" class="pressable ${form.every === h ? "on" : ""}" data-h="${h}">${h}h</button>`).join("")}</div>`)}
      ${id ? `<p class="xs muted" style="margin-top:16px">Se você mudar origem, destino, datas, passageiros ou escalas, o histórico de preços desta rota recomeça (os alertas antigos ficam guardados).</p>` : ""}
      <div id="form-msg" style="margin-top:16px"></div>
      <button class="btn big block bg-brand shadow-float pressable" type="submit" style="margin-top:16px">${id ? "Salvar alterações" : "Começar a vigiar"}</button>
    </form>
  </main>`;
}

viewForm.after = () => {
  const el = document.getElementById("route-form");
  if (!el) return;
  const sync = () => {
    el.querySelectorAll("[data-show]").forEach((x) => {
      const k = x.dataset.show;
      x.hidden = k === "round_trip" ? form.trip_type !== "round_trip" : form.date_mode !== k;
    });
    document.getElementById("chosen").innerHTML = form.destination ? `✓ ${esc(form.origin?.label || "")} (${esc(form.origin?.code || "")}) → ${esc(form.destination.label)} (${esc(form.destination.code)})` : "";
  };
  sync();
  bindSeg("seg-trip", (v) => { form.trip_type = v; sync(); });
  bindSeg("seg-mode", (v) => { form.date_mode = v; sync(); });
  bindSeg("seg-stops", (v) => { form.max_stops = v; });
  el.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    form.adults = Math.min(9, Math.max(1, form.adults + Number(b.dataset.step)));
    document.getElementById("adults").textContent = form.adults;
  }));
  document.getElementById("every").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    form.every = Number(b.dataset.h);
    document.querySelectorAll("#every button").forEach((x) => x.classList.toggle("on", x === b));
  });
  const thr = el.elements.namedItem("threshold_pct");
  thr.addEventListener("input", () => (document.getElementById("thr-out").textContent = thr.value + "%"));
  const dep = el.elements.namedItem("depart_date"), ret = el.elements.namedItem("return_date");
  dep.addEventListener("change", () => { ret.min = dep.value || todayIso(); if (ret.value && ret.value <= dep.value) ret.value = ""; });
  el.querySelectorAll("[data-place]").forEach((wrap) => {
    const name = wrap.dataset.place;
    const input = wrap.querySelector("input");
    const ac = autocomplete(input, wrap.querySelector(".ac-list"), (it) => {
      form[name] = { code: it.code, label: it.label };
      input.value = `${it.label} (${it.code})`;
      sync();
    });
    input.addEventListener("input", () => { form[name] = null; sync(); });
    input.addEventListener("focus", () => input.select());
    input.addEventListener("blur", () => setTimeout(() => {
      if (form[name]) return;
      if (ac.hasItems()) return ac.first();  // saiu sem escolher: usa a primeira sugestão
      const raw = input.value.trim();
      if (/^[a-z]{3}$/i.test(raw)) { form[name] = { code: raw.toUpperCase(), label: raw.toUpperCase() }; input.value = raw.toUpperCase(); sync(); }
    }, 160));
  });
  document.getElementById("swap").addEventListener("click", () => {
    [form.origin, form.destination] = [form.destination, form.origin];
    el.querySelectorAll("[data-place]").forEach((w) => { const c = form[w.dataset.place]; w.querySelector("input").value = c ? `${c.label} (${c.code})` : ""; });
    sync();
  });
  el.addEventListener("submit", saveRoute);
};

async function saveRoute(e) {
  e.preventDefault();
  const el = e.target;
  const f = (n) => el.elements.namedItem(n);
  const msg = document.getElementById("form-msg");
  const fail = (t) => { msg.innerHTML = `<div class="hint bad">${esc(t)}</div>`; msg.scrollIntoView?.({ block: "center", behavior: "smooth" }); };
  msg.innerHTML = "";
  const rt = form.trip_type === "round_trip";
  const today = todayIso();
  if (!form.destination) return fail("Escolha para onde você quer ir.");
  if (!form.origin) return fail("Escolha a origem na lista (ou digite o código de 3 letras).");
  if (form.origin.code === form.destination.code) return fail("Origem e destino precisam ser diferentes.");
  const row = {
    origin: form.origin.code, origin_label: form.origin.label,
    destination: form.destination.code, destination_label: form.destination.label,
    trip_type: form.trip_type, date_mode: form.date_mode,
    depart_date: null, return_date: null, month: null, stay_days: null,
    depart_from: null, depart_to: null, min_stay: null, max_stay: null, track_direct: false,
    adults: form.adults,
    max_stops: form.max_stops === "" ? null : Number(form.max_stops),
    threshold_pct: Number(f("threshold_pct").value),
    target_price: f("target_price").value ? Number(f("target_price").value) : null,
    check_every_hours: form.every,
    check_requested_at: new Date().toISOString(),
    last_error: null,
  };
  if (form.date_mode === "fixed") {
    row.depart_date = f("depart_date").value;
    if (!row.depart_date || row.depart_date <= today) return fail("Escolha uma data de ida a partir de amanhã.");
    if (rt) {
      row.return_date = f("return_date").value;
      if (!row.return_date || row.return_date <= row.depart_date) return fail("A volta precisa ser depois da ida.");
    }
  } else if (form.date_mode === "long") {
    row.depart_from = f("depart_from").value;
    row.depart_to = f("depart_to").value;
    if (!row.depart_from || row.depart_from <= today) return fail("A ida precisa começar a partir de amanhã.");
    if (!row.depart_to || row.depart_to < row.depart_from) return fail("O último dia da ida precisa ser depois do primeiro.");
    if (daysBetween(row.depart_from, row.depart_to) > 62) return fail("A janela de ida pode ter no máximo 2 meses.");
    row.track_direct = f("track_direct").checked && row.max_stops !== 0;
    if (rt) {
      row.min_stay = Number(f("min_stay").value);
      row.max_stay = Number(f("max_stay").value);
      if (!(row.max_stay >= 1 && row.max_stay <= 330)) return fail("Volta no máximo: entre 1 e 330 dias.");
      if (!(row.min_stay >= 1 && row.min_stay <= row.max_stay)) return fail("O mínimo de dias precisa ser menor que o máximo.");
      if (row.max_stay - row.min_stay > 120) return fail("Entre o mínimo e o máximo de dias cabem no máximo 120 dias.");
    }
  } else {
    if (!f("month").value) return fail("Escolha o mês da viagem.");
    row.month = f("month").value + "-01";
    if (row.month.slice(0, 7) < today.slice(0, 7)) return fail("Esse mês já passou.");
    if (rt) {
      row.stay_days = Number(f("stay_days").value);
      if (!(row.stay_days >= 1 && row.stay_days <= 60)) return fail("Dias de viagem: entre 1 e 60.");
    }
  }
  const btn = el.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    let id = form.id;
    if (id) {
      const o = form.original;
      const searchChanged = ["origin", "destination", "trip_type", "date_mode", "depart_date", "return_date", "month", "stay_days", "depart_from", "depart_to", "min_stay", "max_stay", "track_direct", "adults", "max_stops"]
        .some((k) => String(o[k] ?? "") !== String(row[k] ?? ""));
      await q(sb.from("routes").update(row).eq("id", id));
      if (searchChanged) {
        await q(sb.from("price_snapshots").delete().eq("route_id", id));
        await q(sb.from("price_observations").delete().eq("route_id", id));
      }
    } else {
      id = (await q(sb.from("routes").insert({ ...row, active: true }).select("id").single())).id;
    }
    invalidate("routes");
    toast(form.id ? "✅ Rota atualizada! Nova verificação em até ~15 min." : "✅ Rota criada! O robô já vai começar a vigiar.", 4500);
    location.hash = `#/rota/${id}`;
  } catch (err) {
    fail(friendlyError(err));
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Explorar promoções (o robô atualiza a cada 6 h)
// ---------------------------------------------------------------------------
const CITY_NAMES = { RIO: "Rio de Janeiro", SAO: "São Paulo", BHZ: "Belo Horizonte", BSB: "Brasília" };
const explore = { scope: "intl", origin: null };

export async function viewExplore() {
  const [deals, routes, settings] = await Promise.all([
    cached("deals", () => q(sb.from("deals").select("*").order("price").limit(300))),
    q(sb.from("routes").select("origin,origin_label")),
    q(sb.from("settings").select("deals_refreshed_at").eq("id", 1).maybeSingle()),
  ]);
  const origins = [...new Set(deals.map((d) => d.origin))];
  if (!origins.includes(explore.origin)) explore.origin = origins.includes("RIO") ? "RIO" : origins[0];
  const dests = await loadDestinations(deals.map((d) => d.destination));
  Object.assign(explore, { deals, routes, dests });
  const oname = (c) => routes.find((r) => r.origin === c)?.origin_label || CITY_NAMES[c] || c;
  explore.oname = oname;
  return `<main class="page">
    ${back("#/", "Home")}
    <div class="page-title"><h1>Explorar</h1><p>Ida e volta mais baratas dos últimos dias · preço por pessoa · atualizado ${ago(settings?.deals_refreshed_at)}</p></div>
    ${seg("exp-scope", [["intl", "🌎 Internacional"], ["nac", "🇧🇷 Nacional"]], explore.scope)}
    ${origins.length > 1 ? `<div class="origin-chips"><span class="sm muted" style="flex:none">Saindo de</span>${origins.map((o) => `<button type="button" class="${o === explore.origin ? "on" : ""}" data-o="${esc(o)}">${esc(oname(o))}</button>`).join("")}</div>` : ""}
    <div id="exp-list">${!deals.length ? `<div class="card pad center sm muted">O robô ainda está buscando as promoções. Volte em ~15 minutos.</div>` : ""}</div>
  </main>`;
}
viewExplore.after = () => {
  const draw = () => {
    const { deals, dests, scope, origin, oname } = explore;
    const list = deals.filter((d) => d.origin === origin && (scope === "nac" ? d.country_code === "BR" : d.country_code !== "BR"));
    document.getElementById("exp-list").innerHTML = list.length ? list.map((d, i) => dealCard(d, dests[d.destination], oname, i)).join("") : deals.length ? `<div class="card pad center sm muted">Nenhuma promoção nesta categoria agora.</div>` : "";
  };
  bindSeg("exp-scope", (v) => { explore.scope = v; draw(); });
  document.querySelector(".origin-chips")?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-o]"); if (!b) return;
    explore.origin = b.dataset.o;
    document.querySelectorAll(".origin-chips button").forEach((x) => x.classList.toggle("on", x === b));
    draw();
  });
  draw();
};

export function dealCard(d, dest, oname = (c) => c, i = 0) {
  const days = d.return_date ? daysBetween(d.depart_date, d.return_date) : null;
  const track = new URLSearchParams({ orig: d.origin, orignome: oname(d.origin), dest: d.destination, nome: d.destination_label || d.destination, mes: d.depart_date.slice(0, 7), ...(days ? { dias: String(days) } : {}) });
  return `<article class="card deal fade-up" style="animation-delay:${i * 60}ms;margin-top:${i ? 12 : 0}px">
    <a class="deal-photo" href="#/guide/${esc(d.destination)}" ${bg(photo(dest))}></a>
    <div class="deal-body">
      <div class="row between" style="align-items:flex-start;gap:8px">
        <div class="grow"><h3 class="lg b truncate">${esc(d.destination_label || d.destination)}</h3><p class="xs muted">${esc(d.country_name || "")}</p></div>
        <p class="display xb primary-t" style="font-size:20px;flex:none">${brl(d.price)}</p>
      </div>
      <div class="row wrap" style="gap:4px">${pill(`${fmtShort(d.depart_date)}${d.return_date ? ` → ${fmtShort(d.return_date)}` : ""}`)}${days ? pill(`${days} dias`) : ""}${pill(esc([airlineName(d.airline), stopsLabel(d.stops)].filter(Boolean).join(" · ")))}</div>
      <div class="row" style="gap:6px;padding-top:4px">
        <a class="btn primary sm pressable" href="#/nova?${track}">Acompanhar</a>
        <a class="btn sm pressable" href="#/guide/${esc(d.destination)}">Conhecer</a>
        ${d.link ? `<a class="sm b muted" style="font-size:12px;padding:6px 8px" href="${esc(d.link)}" target="_blank" rel="noopener">Oferta ↗</a>` : ""}
      </div>
    </div>
  </article>`;
}
