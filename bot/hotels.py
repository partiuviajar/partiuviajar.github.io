"""Comparador de hotéis: lista de hotéis do Google Hotels com o preço em cada site (Booking, Expedia, Decolar…).

Roda sob demanda: o app grava um pedido em hotel_searches, o Supabase dispara o workflow
"Busca de hotéis" e este script preenche o resultado (hotel a hotel, para o app ir mostrando).
Uso: python hotels.py <id da busca>
"""

import base64
import json
import os
import re
import sys
import time
import traceback
from datetime import date, datetime, timezone
from urllib.parse import parse_qs, quote, urlparse

import requests
from selectolax.lexbor import LexborHTMLParser

from db import DB

BASE = "https://www.google.com"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
}
MAX_HOTELS = 10           # hotéis com preço por site (cada um é uma página do Google)
PAUSE = 1.5


# ---------------------------------------------------------------------------
# Parâmetro "ts" do Google Hotels: datas, hóspedes e moeda (protobuf em base64)
# ---------------------------------------------------------------------------
def _varint(n: int) -> bytes:
    out = b""
    while True:
        b, n = n & 0x7F, n >> 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def _int(num: int, v: int) -> bytes:
    return _varint(num << 3) + _varint(v)


def _bytes(num: int, b: bytes) -> bytes:
    return _varint(num << 3 | 2) + _varint(len(b)) + b


def _date(d: date) -> bytes:
    return _int(1, d.year) + _int(2, d.month) + _int(3, d.day)


def make_ts(checkin: date, checkout: date, adults: int = 2, currency: str = "BRL") -> str:
    guests = b"".join(_bytes(1, _int(1, 3)) for _ in range(adults)) + _int(2, 0)
    nights = (checkout - checkin).days
    dates = _bytes(2, _bytes(2, _bytes(1, _date(checkin)) + _bytes(2, _date(checkout))) + _int(3, nights) + _bytes(6, _int(2, 0)))
    s = (_int(1, 1) + _bytes(2, guests) + _bytes(3, _bytes(1, _bytes(3, b"")) + dates)
         + _bytes(5, _bytes(1, _bytes(7, currency.encode())) + _bytes(3, b"")))
    return base64.urlsafe_b64encode(s).decode().rstrip("=")


# ---------------------------------------------------------------------------
# Leitura das páginas (JSON embutido em <script class="ds:N">, posições não documentadas)
# ---------------------------------------------------------------------------
def _get(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


def _ds(html: str, key: int):
    node = LexborHTMLParser(html).css_first(f"script.ds\\:{key}")
    if node is None:
        raise RuntimeError("página do Google sem dados (bloqueio ou mudança no site)")
    return json.loads(node.text().split("data:", 1)[1].rsplit(",", 1)[0])


def _g(o, *path):
    for k in path:
        try:
            o = o[k]
        except (IndexError, KeyError, TypeError):
            return None
    return o


def _money(o) -> int | None:
    return o[4] if isinstance(o, list) and len(o) == 5 and isinstance(o[0], str) and isinstance(o[4], (int, float)) else None


def _number(v) -> int | None:
    """Total vem como texto ("R$ 1.189"); vira número."""
    if isinstance(v, (int, float)):
        return int(v)
    digits = re.sub(r"\D", "", v or "")
    return int(digits) if digits else None


def search_list(city: str, ts: str, kind: str = "hotel") -> list[dict]:
    term = ("hostels em " if kind == "hostel" else "hotéis em ") + city
    data = _ds(_get(f"{BASE}/travel/search?q={quote(term)}&hl=pt-BR&gl=br&curr=BRL&ts={ts}"), 0)
    hotels = []
    for item in _g(data, 0, 0, 0, 1) or []:
        if not isinstance(item, list) or item[0] != 34:
            continue
        try:
            h = next(iter(item[1].values()))[0]
        except (StopIteration, AttributeError, IndexError, TypeError):
            continue
        if not h or not isinstance(h[1], str) or _g(h, 14) == 2 or _g(h, 7, 0, 0) is None:
            continue  # aluguel de temporada (h[14] == 2) ou sem nota
        latlng = _g(h, 2, 0) or [None, None]
        hotels.append({
            "name": h[1], "stars": _g(h, 3, 1), "rating": _g(h, 7, 0, 0), "reviews": _g(h, 7, 0, 1),
            "image": _g(h, 5, 1, 0, 1, 0), "lat": latlng[0], "lng": latlng[1], "entity": _g(h, 20),
            "night": _g(h, 6, 2, 1, 4), "total": _number(_g(h, 6, 2, 9, 0)), "offers": None,
        })
    return hotels


def offers(entity: str, ts: str) -> list[dict]:
    data = _ds(_get(f"{BASE}/travel/hotels/entity/{entity}/prices?hl=pt-BR&gl=br&curr=BRL&ts={ts}"), 1)
    out = []
    for r in _g(data, 0, 6, 2, 21) or []:
        prov = _g(r, 0)
        if not prov or not isinstance(prov[0], str):
            continue
        link = BASE + prov[2] if isinstance(_g(prov, 2), str) else None
        direct = parse_qs(urlparse(link).query).get("pcurl", [None])[0] if link else None
        night, total = _money(_g(r, 12, 4)), _money(_g(r, 12, 5))
        if night is None and total is None:
            continue
        out.append({"provider": prov[0], "night": night, "total": total, "link": direct or link, "logo": _g(prov, 3, 0)})
    return sorted(out, key=lambda o: o["total"] or (o["night"] or 0) * 1000)


def hotel_page(entity: str, ts: str) -> str:
    return f"{BASE}/travel/hotels/entity/{entity}/prices?hl=pt-BR&gl=br&curr=BRL&ts={ts}"


# ---------------------------------------------------------------------------
# Execução de um pedido
# ---------------------------------------------------------------------------
def run(db: DB, search_id: str):
    row = (db.select("hotel_searches", {"id": f"eq.{search_id}"}) or [None])[0]
    if not row:
        print("busca não encontrada")
        return
    db.update("hotel_searches", {"id": f"eq.{search_id}"}, {"status": "running", "started_at": datetime.now(timezone.utc).isoformat()})
    ci, co = date.fromisoformat(row["checkin"]), date.fromisoformat(row["checkout"])
    ts = make_ts(ci, co, row["adults"] or 2)
    try:
        hotels = search_list(row["city_name"], ts, row.get("kind") or "hotel")[:MAX_HOTELS]
        for h in hotels:
            h["page"] = hotel_page(h.pop("entity"), ts) if h.get("entity") else None
        save = lambda status, **extra: db.update("hotel_searches", {"id": f"eq.{search_id}"}, {"status": status, "results": hotels, **extra})
        save("running")
        # preço por site, hotel a hotel (o app vai mostrando conforme chega)
        for h in hotels:
            entity = re.search(r"/entity/([^/]+)/", h["page"] or "")
            if entity:
                try:
                    h["offers"] = offers(entity.group(1), ts)
                except Exception as e:
                    print(f"[ofertas] {h['name']}: {e}")
                    h["offers"] = []
                save("running")
                time.sleep(PAUSE)
        save("done", finished_at=datetime.now(timezone.utc).isoformat())
        print(f"{len(hotels)} hotéis, {sum(len(h['offers'] or []) for h in hotels)} ofertas")
    except Exception as e:
        traceback.print_exc()
        db.update("hotel_searches", {"id": f"eq.{search_id}"}, {"status": "error", "error": str(e)[:300]})


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 else ""
    if not re.fullmatch(r"[0-9a-f-]{36}", sid):
        sys.exit("uso: python hotels.py <uuid da busca>")
    run(DB(), sid)
