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
from zoneinfo import ZoneInfo

import analysis
import notify
from db import DB
from sources import Quote, SourceError, aviasales, google

TZ = ZoneInfo("America/Sao_Paulo")
GOOGLE_MONTH_BUDGET = int(os.environ.get("GOOGLE_MONTH_BUDGET", "8"))  # buscas no Google por rota "mês inteiro"
MAX_DATES_PER_ALERT = 3


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
    month_now = [q.price for q in best.values()] if route["date_mode"] == "month" else None
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


def prune(db: DB, now: datetime):
    db.delete("price_observations", {"observed_at": f"lt.{(now - timedelta(days=120)).isoformat()}"})
    db.delete("price_snapshots", {"checked_at": f"lt.{(now - timedelta(days=365)).isoformat()}"})
    db.delete("bot_runs", {"started_at": f"lt.{(now - timedelta(days=30)).isoformat()}"})


def main():
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

    for route in due:
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
