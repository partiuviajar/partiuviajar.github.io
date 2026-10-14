"""Google Flights via fast-flights (sem API oficial: lê a página de resultados).

A biblioteca monta a busca e baixa a página; a leitura dos resultados é feita aqui,
de forma tolerante, porque a da biblioteca quebra quando algum voo vem sem preço
(acontece em buscas por cidade, como RIO → BUE).
"""

import json
import time
from urllib.parse import urlencode
from dataclasses import dataclass
from datetime import date

from fast_flights import FlightQuery, Passengers, create_query, fetch_flights_html
from selectolax.lexbor import LexborHTMLParser

from . import Quote, SourceError


def build_query(origin: str, destination: str, depart: date, ret: date | None, adults: int, max_stops: int | None):
    flights = [FlightQuery(date=depart.isoformat(), from_airport=origin, to_airport=destination)]
    if ret:
        flights.append(FlightQuery(date=ret.isoformat(), from_airport=destination, to_airport=origin))
    return create_query(
        flights=flights,
        trip="round-trip" if ret else "one-way",
        passengers=Passengers(adults=adults),
        language="pt-BR",
        currency="BRL",
        max_stops=max_stops,
    )


def search_url(origin: str, destination: str, depart: date, ret: date | None, adults: int, max_stops: int | None) -> str:
    return _url(build_query(origin, destination, depart, ret, adults, max_stops))


def _url(q) -> str:
    # urlencode protege "+" e "/" do código da busca (senão o link quebra no WhatsApp)
    return "https://www.google.com/travel/flights/search?" + urlencode(q.params())


@dataclass
class _Result:
    price: int
    airlines: list[str]
    stops: int
    duration_min: int


def _parse(html: str) -> list[_Result]:
    node = LexborHTMLParser(html).css_first(r"script.ds\:1")
    if node is None:
        raise ValueError("página sem resultados (bloqueio ou tela de consentimento)")
    data = node.text().split("data:", 1)[1].rsplit(",", 1)[0]
    if data.endswith("errorHasStatus: true"):
        return []
    payload = json.loads(data)
    out = []
    for block_idx in (2, 3):  # 2 = "melhores voos", 3 = demais voos
        try:
            block = payload[block_idx][0] or []
        except (IndexError, TypeError):
            continue
        for item in block:
            try:
                price = item[1][0][1]
                flight = item[0]
                legs = flight[2] or []
            except (IndexError, TypeError):
                continue
            if not isinstance(price, (int, float)) or price <= 0:
                continue
            out.append(_Result(
                price=int(price),
                airlines=[a for a in (flight[1] or []) if isinstance(a, str)],
                stops=max(len(legs) - 1, 0),
                duration_min=sum((leg[11] or 0) for leg in legs if len(leg) > 11 and isinstance(leg[11], int)),
            ))
    return out


def cheapest(origin: str, destination: str, depart: date, ret: date | None,
             adults: int = 1, max_stops: int | None = None, retries: int = 2) -> Quote | None:
    """Menor preço do Google Flights para uma combinação de datas. None se não houver voos."""
    q = build_query(origin, destination, depart, ret, adults, max_stops)
    last_err = None
    for attempt in range(retries + 1):
        try:
            results = _parse(fetch_flights_html(q))
            break
        except Exception as e:  # bloqueio, rede, mudança no site
            last_err = e
            time.sleep(4 * (attempt + 1))
    else:
        raise SourceError(f"Google Flights falhou: {type(last_err).__name__}: {str(last_err)[:150]}")

    if not results:
        return None
    best = min(results, key=lambda r: r.price)
    return Quote(
        source="google",
        depart_date=depart,
        return_date=ret,
        price=float(best.price),
        airline=", ".join(best.airlines[:2]) or None,
        stops=best.stops,
        duration_min=best.duration_min or None,
        link=_url(q),
    )
