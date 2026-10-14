"""Google Flights via fast-flights (sem API oficial: lê a página de resultados)."""

import time
from datetime import date

from fast_flights import FlightQuery, FlightsNotFound, Passengers, create_query, get_flights

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
    return build_query(origin, destination, depart, ret, adults, max_stops).url()


def cheapest(origin: str, destination: str, depart: date, ret: date | None,
             adults: int = 1, max_stops: int | None = None, retries: int = 2) -> Quote | None:
    """Menor preço do Google Flights para uma combinação de datas. None se não houver voos."""
    q = build_query(origin, destination, depart, ret, adults, max_stops)
    last_err = None
    for attempt in range(retries + 1):
        try:
            results = get_flights(q)
            break
        except FlightsNotFound:
            return None
        except Exception as e:  # página de bloqueio/consentimento, rede, mudança no site
            last_err = e
            time.sleep(4 * (attempt + 1))
    else:
        raise SourceError(f"Google Flights falhou: {type(last_err).__name__}: {str(last_err)[:150]}")

    valid = [f for f in results if isinstance(f.price, (int, float)) and f.price > 0]
    if not valid:
        return None
    best = min(valid, key=lambda f: f.price)
    names = [a for a in best.airlines if a]
    return Quote(
        source="google",
        depart_date=depart,
        return_date=ret,
        price=float(best.price),
        airline=", ".join(names[:2]) or None,
        stops=max(len(best.flights) - 1, 0),
        duration_min=sum((s.duration or 0) for s in best.flights) or None,
        link=q.url(),
    )
