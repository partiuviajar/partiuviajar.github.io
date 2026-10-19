"""Radar de Voos: verifica as rotas que estão na hora, guarda os preços e envia alertas.

Roda a cada 15 minutos no GitHub Actions; cada rota só é consultada no intervalo
escolhido no app (ou na hora, se você tocar em "Verificar agora").
Uso local:  python main.py [--force]
"""

import os
import random
import sys
import time
import traceback
from calendar import monthrange
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from itertools import zip_longest
from zoneinfo import ZoneInfo

import analysis
import notify
from db import DB
from sources import Quote, SourceError, aviasales, google

TZ = ZoneInfo("America/Sao_Paulo")
GOOGLE_MONTH_BUDGET = int(os.environ.get("GOOGLE_MONTH_BUDGET", "8"))  # buscas no Google por rota "mês inteiro"
MAX_DATES_PER_ALERT = 3
RUN_TIME_BUDGET_S = 18 * 60  # não começa rota nova depois disso


def parse_ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def to_date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def key(dep: date | str, ret: date | str | None) -> tuple[str, str | None]:
    dep = dep if isinstance(dep, str) else dep.isoformat()
    ret = ret if (ret is None or isinstance(ret, str)) else ret.isoformat()
    return dep, ret


def target_dates(route: dict, today: date) -> list[tuple[date, date | None]]:
    """Combinações de datas (ida, volta) que a rota deve acompanhar, só no futuro."""
    rt = route["trip_type"] == "round_trip"
    if route["date_mode"] == "fixed":
        dep = to_date(route["depart_date"])
        ret = to_date(route["return_date"]) if rt else None
        return [(dep, ret)] if dep > today else []
    first = to_date(route["month"]).replace(day=1)
    out = []
    for i in range(monthrange(first.year, first.month)[1]):
        dep = first + timedelta(days=i)
        if dep > today:
            out.append((dep, dep + timedelta(days=route["stay_days"]) if rt else None))
    return out


def is_due(route: dict, now: datetime) -> bool:
    last = parse_ts(route.get("last_checked_at"))
    requested = parse_ts(route.get("check_requested_at"))
    if last is None or (requested and requested > last):
        return True
    return now - last >= timedelta(hours=route["check_every_hours"]) - timedelta(minutes=10)


def latest_google_checks(db: DB, route_id: str, now: datetime) -> dict[str, str]:
    rows = db.select_all("price_observations", {
        "select": "depart_date,observed_at",
        "route_id": f"eq.{route_id}",
        "source": "eq.google",
        "observed_at": f"gte.{(now - timedelta(days=3)).isoformat()}",
        "order": "observed_at.desc",
    })
    out: dict[str, str] = {}
    for r in rows:
        out.setdefault(r["depart_date"], r["observed_at"])
    return out


def collect_quotes(db: DB, route: dict, dates: list[tuple[date, date | None]], now: datetime) -> tuple[list[Quote], list[str]]:
    month_mode = route["date_mode"] == "month"
    rt = route["trip_type"] == "round_trip"
    o, d, adults, max_stops = route["origin"], route["destination"], route["adults"], route["max_stops"]
    wanted = {key(a, b) for a, b in dates}
    quotes: list[Quote] = []
    errors: list[str] = []

    # 1) Aviasales: o mês inteiro numa chamada só (ou a data fixa)
    if aviasales.enabled():
        try:
            if month_mode:
                found = aviasales.month_prices(o, d, to_date(route["month"]), route["stay_days"] if rt else None, adults, max_stops)
                quotes += [q for q in found.values() if key(q.depart_date, q.return_date) in wanted]
            else:
                q = aviasales.fixed_price(o, d, dates[0][0], dates[0][1], adults, max_stops)
                if q:
                    quotes.append(q)
        except SourceError as e:
            errors.append(str(e))

    # 2) Google Flights: data fixa sempre; no mês, os dias mais baratos + um rodízio dos demais
    if month_mode:
        cheapest_first = sorted(quotes, key=lambda q: q.price)
        picks = [(q.depart_date, q.return_date) for q in cheapest_first[: GOOGLE_MONTH_BUDGET // 2]]
        last_check = latest_google_checks(db, route["id"], now)
        rest = sorted((dt for dt in dates if dt not in picks), key=lambda dt: last_check.get(dt[0].isoformat(), ""))
        # enquanto houver dias nunca consultados (rota nova), faz mais buscas por rodada para preencher o calendário
        never = sum(1 for dt in dates if dt[0].isoformat() not in last_check)
        budget = max(GOOGLE_MONTH_BUDGET, min(16, never + len(picks)))
        picks += rest[: budget - len(picks)]
    else:
        picks = dates

    failures = empty = 0
    for dep, ret in picks:
        try:
            q = google.cheapest(o, d, dep, ret, adults, max_stops)
            failures = 0
            if q:
                quotes.append(q)
            else:
                empty += 1
        except SourceError as e:
            failures += 1
            if failures == 1:
                errors.append(str(e))
            if failures >= 2:
                errors.append("Google Flights pausado nesta rodada após falhas seguidas.")
                break
        time.sleep(random.uniform(2, 5))
    print(f"[google] {len(picks)} buscas, {empty} sem voos, {failures} falhas no fim")
    return quotes, errors


def check_route(db: DB, route: dict, settings: dict, now: datetime) -> tuple[str, bool]:
    if route["date_mode"] == "long":
        return check_long_route(db, route, settings, now)
    title = notify.route_title(route)
    rid = route["id"]
    today = now.astimezone(TZ).date()
    dates = target_dates(route, today)
    if not dates:
        db.update("routes", {"id": f"eq.{rid}"}, {
            "active": False, "last_checked_at": now.isoformat(),
            "last_error": "As datas desta rota já passaram. A rota foi pausada.",
        })
        return f"{title}: datas já passaram, rota pausada", False

    quotes, errors = collect_quotes(db, route, dates, now)
    db.insert("price_observations", [{
        "route_id": rid, "observed_at": now.isoformat(), "source": q.source,
        "depart_date": q.depart_date.isoformat(), "return_date": q.return_date.isoformat() if q.return_date else None,
        "price": round(q.price, 2), "airline": q.airline, "stops": q.stops, "duration_min": q.duration_min, "link": q.link,
    } for q in quotes])

    best: dict[tuple, Quote] = {}
    for q in quotes:
        k = key(q.depart_date, q.return_date)
        if k not in best or q.price < best[k].price:
            best[k] = q

    if not best:
        msg = "; ".join(errors) or "Nenhum preço encontrado nesta verificação."
        db.update("routes", {"id": f"eq.{rid}"}, {"last_checked_at": now.isoformat(), "last_error": msg})
        return f"{title}: nenhum preço ({msg})", bool(errors)

    # histórico de 30 dias de cada data
    hist_rows = db.select_all("price_snapshots", {
        "select": "depart_date,return_date,price",
        "route_id": f"eq.{rid}",
        "checked_at": f"gte.{(now - timedelta(days=30)).isoformat()}",
        "order": "checked_at.asc",
    })
    history: dict[tuple, list[float]] = defaultdict(list)
    for r in hist_rows:
        history[key(r["depart_date"], r["return_date"])].append(float(r["price"]))

    recent_alerts = db.select("alerts", {
        "select": "depart_date,return_date,price",
        "route_id": f"eq.{rid}",
        "created_at": f"gte.{(now - timedelta(days=7)).isoformat()}",
    })
    last_alerted: dict[tuple, float] = {}
    for a in recent_alerts:
        k = key(a["depart_date"], a["return_date"])
        last_alerted[k] = min(float(a["price"]), last_alerted.get(k, float("inf")))

    aviasales_links = {key(q.depart_date, q.return_date): q.link for q in quotes if q.source == "aviasales" and q.link}
    month_now = None
    if route["date_mode"] == "month":
        # preço mais recente de cada dia do mês: desta rodada ou, se o dia não foi consultado agora, o último conhecido
        wanted = {key(a, b) for a, b in dates}
        latest = {k: prices[-1] for k, prices in history.items() if k in wanted}
        latest.update({k: q.price for k, q in best.items()})
        month_now = list(latest.values())
    target = float(route["target_price"]) if route.get("target_price") else None
    snapshots, candidates = [], []
    for k, q in best.items():
        hist = history.get(k, [])
        normal, _basis = analysis.normal_price(hist, month_now)
        snapshots.append({
            "route_id": rid, "checked_at": now.isoformat(), "depart_date": k[0], "return_date": k[1],
            "price": round(q.price, 2), "normal_price": round(normal, 2) if normal else None,
            "source": q.source, "airline": q.airline, "stops": q.stops, "link": q.link,
        })
        verdict = analysis.evaluate(q.price, normal, hist, route["threshold_pct"], target)
        if verdict.alert and not analysis.is_repeat(q.price, last_alerted.get(k)):
            candidates.append({
                "depart_date": k[0], "return_date": k[1], "price": round(q.price, 2),
                "normal_price": round(normal, 2) if normal else None, "pct_below": verdict.pct_below,
                "reasons": verdict.reasons, "source": q.source, "airline": q.airline,
                "stops": q.stops, "link": q.link,
                # links de compra: Google Flights sempre (abre com as datas certas) + Aviasales se houver
                "google_link": q.link if q.source == "google" else google.search_url(
                    route["origin"], route["destination"], q.depart_date, q.return_date, route["adults"], route["max_stops"]),
                "aviasales_link": aviasales_links.get(k),
            })
    db.insert("price_snapshots", snapshots)

    sent = ""
    if candidates:
        items = sorted(candidates, key=lambda c: c["price"])[:MAX_DATES_PER_ALERT]
        alert_title, text = notify.alert_message(route, items)
        used = notify.broadcast(db, settings, alert_title, text, notify.app_url(f"#/rota/{rid}"))
        db.insert("alerts", [{
            "route_id": rid, "channels": used,
            **{k: v for k, v in it.items() if k not in ("stops", "google_link", "aviasales_link")},
        } for it in items])
        sent = f", {len(items)} alerta(s) via {', '.join(used) or 'nenhum canal'}"

    db.update("routes", {"id": f"eq.{rid}"}, {
        "last_checked_at": now.isoformat(), "last_error": "; ".join(errors) or None,
    })
    cheapest = min(best.values(), key=lambda q: q.price)
    by_source = {s: sum(1 for q in quotes if q.source == s) for s in ("google", "aviasales")}
    line = (f"{title}: {len(best)} data(s) [google {by_source['google']}, aviasales {by_source['aviasales']}], "
            f"menor {notify.brl(cheapest.price)}{sent}")
    if errors:
        line += " | avisos: " + "; ".join(errors)
    return line, bool(errors)


# ---------------------------------------------------------------------------
# Viagem longa: ida numa janela de datas e volta entre X e Y dias depois.
# Compara "ida e volta na mesma passagem" com "duas passagens só de ida".
# Cada preço é guardado por trecho (leg): out = só ida, back = só volta (destino → origem),
# rt = ida e volta, combo = melhor soma de uma ida + uma volta.
# direct_only = série que só considera voos diretos (quando a rota acompanha os dois).
# ---------------------------------------------------------------------------
GOOGLE_LONG_BUDGET = int(os.environ.get("GOOGLE_LONG_BUDGET", "14"))
LONG_RT_PICKS = 4             # pares de ida e volta conferidos no Google por rodada
LONG_HISTORY_DAYS = 15
LEG_FRESH = timedelta(hours=48)  # preço de um trecho vale para montar o total por até 48 h
MAX_RT_SNAPSHOTS = 30         # guarda só os pares de ida e volta mais baratos de cada rodada
MAX_LONG_ALERT_ITEMS = 4
RT_MAX_STAY = 30              # Google e Aviasales só mostram ida e volta na mesma passagem para viagens de até ~30 dias


def as_date(value: date | str) -> date:
    return value if isinstance(value, date) else date.fromisoformat(value)


def long_windows(route: dict, today: date) -> tuple[list[date], list[date]]:
    """(dias de ida, dias de volta) que a rota acompanha, só no futuro."""
    start, end = to_date(route["depart_from"]), to_date(route["depart_to"])
    outs = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    outs = [x for x in outs if x > today]
    if route["trip_type"] != "round_trip" or not outs:
        return outs, []
    first = outs[0] + timedelta(days=route["min_stay"] or 1)
    last = outs[-1] + timedelta(days=route["max_stay"])
    return outs, [first + timedelta(days=i) for i in range((last - first).days + 1)]


def stay_ok(route: dict, dep: date | str, ret: date | str) -> bool:
    n = (as_date(ret) - as_date(dep)).days
    return (route["min_stay"] or 1) <= n <= route["max_stay"]


def months_of(days: list[date]) -> list[date]:
    return sorted({x.replace(day=1) for x in days})


def long_series(route: dict) -> list[bool]:
    """False = melhor preço (respeita o filtro de escalas); True = só voos diretos."""
    return [False, True] if route.get("track_direct") and route["max_stops"] != 0 else [False]


def latest_google_long(db: DB, route_id: str, now: datetime) -> dict[tuple[str, str], str]:
    rows = db.select_all("price_observations", {
        "select": "leg,depart_date,observed_at",
        "route_id": f"eq.{route_id}",
        "source": "eq.google",
        "observed_at": f"gte.{(now - timedelta(days=3)).isoformat()}",
        "order": "observed_at.desc",
    })
    out: dict[tuple[str, str], str] = {}
    for r in rows:
        out.setdefault((r["leg"], r["depart_date"]), r["observed_at"])
    return out


def collect_long(db: DB, route: dict, outs: list[date], backs: list[date], now: datetime) -> tuple[list[tuple[str, Quote]], list[str]]:
    o, d, adults, max_stops = route["origin"], route["destination"], route["adults"], route["max_stops"]
    out_set, back_set = set(outs), set(backs)
    found: list[tuple[str, Quote]] = []
    errors: list[str] = []

    # 1) Aviasales: poucas chamadas por mês trazem muitos dias de uma vez.
    #    Ida e volta só quando a volta fica a até 30 dias do fim do mês da ida (limite da API).
    def avia(leg, keep, *args):
        try:
            return [(leg, q) for q in aviasales.search(*args, adults, max_stops) if keep(q)]
        except SourceError as e:
            errors.append(str(e))
            return []

    if aviasales.enabled():
        for m in months_of(outs):
            found += avia("out", lambda q: q.depart_date in out_set, o, d, m, None)
        for m in months_of(backs):
            found += avia("back", lambda q: q.depart_date in back_set, d, o, m, None)
            for om in months_of(outs):
                month_end = date(om.year, om.month, monthrange(om.year, om.month)[1])
                if (m - month_end).days <= 30:
                    found += avia("rt", lambda q: q.depart_date in out_set and stay_ok(route, q.depart_date, q.return_date), o, d, om, m)

    # preço conhecido de cada dia (últimas 48 h + o que o Aviasales trouxe agora), para escolher o que conferir
    known: dict[tuple[str, date], float] = {}
    for r in db.select_all("price_snapshots", {
        "select": "leg,direct_only,depart_date,price",
        "route_id": f"eq.{route['id']}",
        "leg": "in.(out,back)",
        "direct_only": "is.false",
        "checked_at": f"gte.{(now - LEG_FRESH).isoformat()}",
        "order": "checked_at.asc",
    }):
        if r["leg"] in ("out", "back") and not r["direct_only"]:
            known[(r["leg"], as_date(r["depart_date"]))] = float(r["price"])
    fresh: dict[tuple[str, date], float] = {}
    for l, q in found:
        if l in ("out", "back"):
            fresh[(l, q.depart_date)] = min(q.price, fresh.get((l, q.depart_date), float("inf")))
    known.update(fresh)
    out_p = {x: p for (l, x), p in known.items() if l == "out" and x in out_set}
    back_p = {x: p for (l, x), p in known.items() if l == "back" and x in back_set}

    # 2) Google Flights: confere os mais baratos e faz rodízio dos demais dias.
    #    Ida e volta (só viagens de até 30 dias): os pares do Aviasales e as melhores somas de ida + volta já conhecidas.
    picks: list[tuple[str, date, date | None]] = []
    rt_ok = lambda dep, ret: (ret - dep).days <= RT_MAX_STAY
    for q in sorted((q for l, q in found if l == "rt"), key=lambda q: q.price)[:2]:
        if ("rt", q.depart_date, q.return_date) not in picks:
            picks.append(("rt", q.depart_date, q.return_date))
    sums = sorted((op + bp, dep, ret) for dep, op in out_p.items() for ret, bp in back_p.items()
                  if stay_ok(route, dep, ret) and rt_ok(dep, ret))
    used_days: set[date] = set()
    for _total, dep, ret in sums:  # um par por dia de ida, para variar
        if len(picks) >= LONG_RT_PICKS:
            break
        if dep not in used_days and ("rt", dep, ret) not in picks:
            used_days.add(dep)
            picks.append(("rt", dep, ret))
    picks += [("out", x, None) for x in sorted(out_p, key=out_p.get)[:2]]
    picks += [("back", x, None) for x in sorted(back_p, key=back_p.get)[:2]]

    last_check = latest_google_long(db, route["id"], now)
    days = [p for pair in zip_longest([("out", x, None) for x in outs], [("back", x, None) for x in backs])
            for p in pair if p and p not in picks]
    stamp = lambda p: last_check.get((p[0], p[1].isoformat()), "")
    rotation = sorted(days, key=stamp)  # nunca consultados primeiro, depois os mais antigos
    never = sum(1 for p in days if not stamp(p))
    budget = max(GOOGLE_LONG_BUDGET, min(24, len(picks) + never))
    picks = picks[:budget] + rotation[: max(0, budget - len(picks))]

    failures = empty = 0
    for leg, dep, ret in picks:
        src, dst = (d, o) if leg == "back" else (o, d)
        try:
            qs = google.options(src, dst, dep, ret, adults, max_stops)
            failures = 0
            found += [(leg, q) for q in qs]
            empty += not qs
        except SourceError as e:
            failures += 1
            if failures == 1:
                errors.append(str(e))
            if failures >= 2:
                errors.append("Google Flights pausado nesta rodada após falhas seguidas.")
                break
        time.sleep(random.uniform(2, 5))
    print(f"[google] {len(picks)} buscas (viagem longa), {empty} sem voos, {failures} falhas no fim")
    return found, errors


def check_long_route(db: DB, route: dict, settings: dict, now: datetime) -> tuple[str, bool]:
    title = notify.route_title(route)
    rid = route["id"]
    o, d = route["origin"], route["destination"]
    outs, backs = long_windows(route, now.astimezone(TZ).date())
    if not outs:
        db.update("routes", {"id": f"eq.{rid}"}, {
            "active": False, "last_checked_at": now.isoformat(),
            "last_error": "As datas de ida desta rota já passaram. A rota foi pausada.",
        })
        return f"{title}: datas já passaram, rota pausada", False

    found, errors = collect_long(db, route, outs, backs, now)
    db.insert("price_observations", [{
        "route_id": rid, "observed_at": now.isoformat(), "source": q.source, "leg": leg,
        "depart_date": q.depart_date.isoformat(), "return_date": q.return_date.isoformat() if q.return_date else None,
        "price": round(q.price, 2), "airline": q.airline, "stops": q.stops, "duration_min": q.duration_min, "link": q.link,
    } for leg, q in found])

    series = long_series(route)
    best: dict[tuple, Quote] = {}  # (leg, direct_only, ida, volta)
    for leg, q in found:
        for direct_only in series:
            if direct_only and q.stops != 0:
                continue
            k = (leg, direct_only, *key(q.depart_date, q.return_date))
            if k not in best or q.price < best[k].price:
                best[k] = q
    for direct_only in series:
        rts = sorted((k for k in best if k[0] == "rt" and k[1] == direct_only), key=lambda k: best[k].price)
        for k in rts[MAX_RT_SNAPSHOTS:]:
            del best[k]

    if not best:
        msg = "; ".join(errors) or "Nenhum preço encontrado nesta verificação."
        db.update("routes", {"id": f"eq.{rid}"}, {"last_checked_at": now.isoformat(), "last_error": msg})
        return f"{title}: nenhum preço ({msg})", bool(errors)

    # histórico recente: preços por data (para o "normal") e último preço conhecido de cada trecho
    hist_rows = db.select_all("price_snapshots", {
        "select": "leg,direct_only,depart_date,return_date,price,checked_at,source,airline,stops,link",
        "route_id": f"eq.{rid}",
        "checked_at": f"gte.{(now - timedelta(days=LONG_HISTORY_DAYS)).isoformat()}",
        "order": "checked_at.asc",
    })
    history: dict[tuple, list[float]] = defaultdict(list)
    latest: dict[tuple, dict] = {}
    for r in hist_rows:
        if r["leg"] == "combo":
            history[("combo", r["direct_only"])].append(float(r["price"]))
            continue
        k = (r["leg"], r["direct_only"], *key(r["depart_date"], r["return_date"]))
        history[k].append(float(r["price"]))
        latest[k] = r
    for k, q in best.items():
        latest[k] = {"price": q.price, "checked_at": now.isoformat(), "source": q.source,
                     "airline": q.airline, "stops": q.stops, "link": q.link}

    out_iso, back_iso = {x.isoformat() for x in outs}, {x.isoformat() for x in backs}

    def in_scope(k: tuple) -> bool:
        leg, _, dep, ret = k
        if leg == "out":
            return dep in out_iso
        if leg == "back":
            return dep in back_iso
        return dep in out_iso and ret is not None and stay_ok(route, dep, ret)

    latest = {k: v for k, v in latest.items() if in_scope(k)}
    cross: dict[tuple, list[float]] = defaultdict(list)  # preços atuais de cada trecho, para o "normal" no começo
    for k, v in latest.items():
        cross[k[:2]].append(float(v["price"]))

    last_alerted: dict[tuple, float] = {}
    for a in db.select("alerts", {
        "select": "leg,direct_only,depart_date,return_date,price",
        "route_id": f"eq.{rid}",
        "created_at": f"gte.{(now - timedelta(days=7)).isoformat()}",
    }):
        # o total da viagem é um alerta só, mesmo que as datas do melhor par mudem
        k = ("combo", a["direct_only"], None, None) if a["leg"] == "combo" else (a["leg"], a["direct_only"], *key(a["depart_date"], a["return_date"]))
        last_alerted[k] = min(float(a["price"]), last_alerted.get(k, float("inf")))

    target = float(route["target_price"]) if route.get("target_price") else None
    adults, max_stops = route["adults"], route["max_stops"]
    aviasales_links = {(leg, *key(q.depart_date, q.return_date)): q.link for leg, q in found if q.source == "aviasales" and q.link}
    snapshots, candidates = [], []

    def consider(k: tuple, price: float, normal: float | None, hist: list[float], alert_key: tuple, item: dict):
        # preço-alvo é do total da viagem: não vale para um trecho sozinho
        verdict = analysis.evaluate(price, normal, hist, route["threshold_pct"], target if k[0] in ("rt", "combo") else None)
        if verdict.alert and not analysis.is_repeat(price, last_alerted.get(alert_key)):
            candidates.append({
                "leg": k[0], "direct_only": k[1], "depart_date": k[2], "return_date": k[3],
                "price": round(price, 2), "normal_price": round(normal, 2) if normal else None,
                "pct_below": verdict.pct_below, "reasons": verdict.reasons, **item,
            })

    for k, q in best.items():
        leg, direct_only, dep, ret = k
        hist = history.get(k, [])
        normal, _basis = analysis.normal_price(hist, cross[k[:2]])
        snapshots.append({
            "route_id": rid, "checked_at": now.isoformat(), "leg": leg, "direct_only": direct_only,
            "depart_date": dep, "return_date": ret, "price": round(q.price, 2),
            "normal_price": round(normal, 2) if normal else None,
            "source": q.source, "airline": q.airline, "stops": q.stops, "link": q.link,
        })
        src, dst = (d, o) if leg == "back" else (o, d)
        consider(k, q.price, normal, hist, k, {
            "source": q.source, "airline": q.airline, "stops": q.stops, "link": q.link,
            "google_link": q.link if q.source == "google" else google.search_url(src, dst, q.depart_date, q.return_date, adults, max_stops),
            "aviasales_link": aviasales_links.get((leg, dep, ret)),
        })

    # melhor total com duas passagens só de ida (preços de cada trecho com até 48 h)
    combos = []
    fresh = lambda v: parse_ts(v["checked_at"]) >= now - LEG_FRESH
    for direct_only in series:
        legs = {leg: {k[2]: v for k, v in latest.items() if k[0] == leg and k[1] == direct_only and fresh(v)} for leg in ("out", "back")}
        pairs = [(float(ov["price"]) + float(bv["price"]), dep, ret, ov, bv)
                 for dep, ov in legs["out"].items() for ret, bv in legs["back"].items() if stay_ok(route, dep, ret)]
        if not pairs:
            continue
        total, dep, ret, ov, bv = min(pairs, key=lambda p: p[0])
        hist = history.get(("combo", direct_only), [])
        normal, _basis = analysis.normal_price(hist, None)
        airline = f"ida: {ov['airline'] or '?'} · volta: {bv['airline'] or '?'}"
        stops = max(ov["stops"] or 0, bv["stops"] or 0) if ov["stops"] is not None and bv["stops"] is not None else None
        snapshots.append({
            "route_id": rid, "checked_at": now.isoformat(), "leg": "combo", "direct_only": direct_only,
            "depart_date": dep, "return_date": ret, "price": round(total, 2),
            "normal_price": round(normal, 2) if normal else None,
            "source": ov["source"] if ov["source"] == bv["source"] else "misto",
            "airline": airline, "stops": stops, "link": None,
        })
        combos.append((direct_only, total))
        consider(("combo", direct_only, dep, ret), total, normal, hist, ("combo", direct_only, None, None), {
            "source": None, "airline": airline, "stops": stops, "link": None,
            "google_link": ov["link"] if ov["source"] == "google" and ov["link"] else google.search_url(o, d, as_date(dep), None, adults, max_stops),
            "google_link_back": bv["link"] if bv["source"] == "google" and bv["link"] else google.search_url(d, o, as_date(ret), None, adults, max_stops),
        })
    db.insert("price_snapshots", snapshots)

    sent = ""
    if candidates:
        # primeiro o preço da viagem toda, depois os trechos sozinhos
        order = {"combo": 0, "rt": 1, "out": 2, "back": 3}
        items = sorted(candidates, key=lambda c: (order[c["leg"]], c["price"]))[:MAX_LONG_ALERT_ITEMS]
        alert_title, text = notify.alert_message(route, items)
        used = notify.broadcast(db, settings, alert_title, text, notify.app_url(f"#/rota/{rid}"))
        db.insert("alerts", [{
            "route_id": rid, "channels": used,
            **{k: v for k, v in it.items() if k not in ("stops", "google_link", "google_link_back", "aviasales_link")},
        } for it in items])
        sent = f", {len(items)} alerta(s) via {', '.join(used) or 'nenhum canal'}"

    db.update("routes", {"id": f"eq.{rid}"}, {
        "last_checked_at": now.isoformat(), "last_error": "; ".join(errors) or None,
    })
    count = lambda leg: sum(1 for k in best if k[0] == leg and not k[1])
    rt_best = min((q.price for k, q in best.items() if k[0] == "rt" and not k[1]), default=None)
    combo_best = next((t for dir_only, t in combos if not dir_only), None)
    line = (f"{title} (viagem longa): ida {count('out')} dia(s), volta {count('back')}, pares {count('rt')}; "
            f"ida e volta {notify.brl(rt_best)}, duas só ida {notify.brl(combo_best)}{sent}")
    if errors:
        line += " | avisos: " + "; ".join(errors)
    return line, bool(errors)


def prune(db: DB, now: datetime):
    db.delete("price_observations", {"observed_at": f"lt.{(now - timedelta(days=120)).isoformat()}"})
    db.delete("price_snapshots", {"checked_at": f"lt.{(now - timedelta(days=365)).isoformat()}"})
    # viagem longa gera muitas linhas por rodada: guarda só 60 dias
    db.delete("price_snapshots", {"leg": "not.is.null", "checked_at": f"lt.{(now - timedelta(days=60)).isoformat()}"})
    db.delete("bot_runs", {"started_at": f"lt.{(now - timedelta(days=30)).isoformat()}"})


def main():
    started = time.monotonic()
    db = DB()
    now = datetime.now(timezone.utc)
    settings = (db.select("settings", {"id": "eq.1"}) or [{}])[0]
    db.update("settings", {"id": "eq.1"}, {
        "bot_heartbeat_at": now.isoformat(),
        "bot_channels": {**notify.channels_status(), "aviasales": aviasales.enabled()},
    })

    requested, done = parse_ts(settings.get("test_requested_at")), parse_ts(settings.get("test_done_at"))
    wants_test = bool(requested and (done is None or requested > done))
    routes = db.select("routes", {"active": "eq.true", "order": "created_at.asc"})
    due = routes if "--force" in sys.argv else [r for r in routes if is_due(r, now)]

    if not wants_test and not due:
        print(f"Nada a fazer agora ({len(routes)} rota(s) ativa(s)).")
        return

    run = db.insert("bot_runs", {"started_at": now.isoformat()}, returning=True)[0]
    summaries, status = [], "ok"

    if wants_test:
        used = notify.broadcast(
            db, settings, "✈️ Radar de Voos",
            "✈️ *Radar de Voos*\nTeste de notificação: se você está lendo isto, os avisos estão funcionando! 🎉",
            notify.app_url(),
        )
        db.update("settings", {"id": "eq.1"}, {"test_done_at": now.isoformat()})
        summaries.append(f"Teste enviado por: {', '.join(used) or 'nenhum canal (verifique a configuração)'}")

    for i, route in enumerate(due):
        # o GitHub encerra o robô em 25 min; o que sobrar fica para a próxima rodada (15 min depois)
        if time.monotonic() - started > RUN_TIME_BUDGET_S:
            line = f"{len(due) - i} rota(s) ficaram para a próxima rodada (tempo esgotado)."
            print(line)
            summaries.append(line)
            break
        try:
            line, had_errors = check_route(db, route, settings, now)
            if had_errors:
                status = "partial"
        except Exception as e:
            traceback.print_exc()
            status = "partial"
            line = f"{notify.route_title(route)}: erro inesperado: {e}"
            db.update("routes", {"id": f"eq.{route['id']}"}, {"last_checked_at": now.isoformat(), "last_error": str(e)[:300]})
        print(line)
        summaries.append(line)

    try:
        prune(db, now)
    except Exception as e:
        print(f"[limpeza] {e}")

    db.update("bot_runs", {"id": f"eq.{run['id']}"}, {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "summary": "\n".join(summaries)[:4000],
    })


if __name__ == "__main__":
    main()
