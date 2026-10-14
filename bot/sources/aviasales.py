"""Aviasales / Travelpayouts Data API (grátis, preços em cache das buscas recentes)."""

import os
from datetime import date, datetime

import requests

from . import Quote, SourceError

API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"


def _token() -> str | None:
    return os.environ.get("TRAVELPAYOUTS_TOKEN") or None


def enabled() -> bool:
    return _token() is not None


def _fetch(params: dict) -> list[dict]:
    base = {"currency": "brl", "sorting": "price", "unique": "false", "limit": 1000, "token": _token()}
    try:
        r = requests.get(API, params={**base, **params}, timeout=30)
        data = r.json()
    except Exception as e:
        raise SourceError(f"Aviasales falhou: {type(e).__name__}: {str(e)[:150]}")
    if r.status_code >= 400 or not data.get("success", False):
        raise SourceError(f"Aviasales respondeu {r.status_code}: {str(data)[:150]}")
    return data.get("data") or []


def _day(value: str | None) -> date | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).date()


def _to_quote(item: dict, adults: int) -> Quote:
    stops = max(item.get("transfers") or 0, item.get("return_transfers") or 0)
    link = item.get("link")
    return Quote(
        source="aviasales",
        depart_date=_day(item.get("departure_at")),
        return_date=_day(item.get("return_at")),
        # a API devolve o preço de 1 adulto
        price=float(item["price"]) * adults,
        airline=item.get("airline"),
        stops=stops,
        duration_min=item.get("duration"),
        # só o caminho da busca (ex.: /search/SAO0312LIS1): link curto que abre a busca com as mesmas datas
        link=f"https://www.aviasales.com{link.split('?')[0]}" if link else None,
    )


def _ok_stops(item: dict, max_stops: int | None) -> bool:
    if max_stops is None:
        return True
    return max(item.get("transfers") or 0, item.get("return_transfers") or 0) <= max_stops


def month_prices(origin: str, destination: str, month: date, stay_days: int | None,
                 adults: int = 1, max_stops: int | None = None) -> dict[date, Quote]:
    """Menor preço por dia de ida dentro do mês. Para ida e volta, só conta viagens com exatamente `stay_days` dias."""
    params = {
        "origin": origin,
        "destination": destination,
        "departure_at": month.strftime("%Y-%m"),
        "one_way": "false" if stay_days else "true",
    }
    if max_stops == 0:
        params["direct"] = "true"
    best: dict[date, Quote] = {}
    for item in _fetch(params):
        if not _ok_stops(item, max_stops):
            continue
        q = _to_quote(item, adults)
        if q.depart_date is None:
            continue
        if stay_days:
            if q.return_date is None or (q.return_date - q.depart_date).days != stay_days:
                continue
        if q.depart_date not in best or q.price < best[q.depart_date].price:
            best[q.depart_date] = q
    return best


def fixed_price(origin: str, destination: str, depart: date, ret: date | None,
                adults: int = 1, max_stops: int | None = None) -> Quote | None:
    params = {
        "origin": origin,
        "destination": destination,
        "departure_at": depart.isoformat(),
        "one_way": "false" if ret else "true",
    }
    if ret:
        params["return_at"] = ret.isoformat()
    if max_stops == 0:
        params["direct"] = "true"
    for item in _fetch(params):  # já vem ordenado por preço
        if _ok_stops(item, max_stops):
            return _to_quote(item, adults)
    return None
