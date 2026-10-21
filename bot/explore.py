"""Explorar: promoções saindo das suas origens e informações dos destinos.

O app só lê o que fica pronto aqui (fotos, resumo, pontos turísticos, moeda, idioma, tomada),
porque algumas consultas (pontos turísticos no Wikidata) levam dezenas de segundos.
"""

import math
import os
import time
import unicodedata
from datetime import date, datetime, timedelta
from urllib.parse import quote

import requests

import ai
import experiences
from sources import SourceError, aviasales

DEALS_EVERY = timedelta(hours=6)
DOMESTIC_DEALS = 30
INTERNATIONAL_DEALS = 40
NEW_DESTINATIONS_PER_RUN = 8
ATTRACTIONS_PER_RUN = 2
EXPERIENCES_PER_RUN = 2
COSTS_PER_RUN = 4
EXPERIENCES_REFRESH = timedelta(days=7)
DESTINATION_REFRESH = timedelta(days=60)
DEFAULT_ORIGIN = "RIO"
HEADERS = {"User-Agent": "radar-voos/1.0 (https://github.com/partiuviajar/partiuviajar.github.io)"}
SPARQL = "https://query.wikidata.org/sparql"
ACCOUNTING_UNITS = {"CLF", "USN", "BOV", "COU", "MXV", "UYI", "UYW", "CHE", "CHW", "XDR"}
# países em que o idioma oficial no Wikidata não é o que o viajante encontra na rua
LANGUAGE_OVERRIDES = {"US": ["inglês"], "GB": ["inglês"], "AU": ["inglês"], "CA": ["inglês", "francês"]}

# tipos de lugar que contam como ponto turístico (museus, praças, parques, igrejas, mirantes…)
ATTRACTION_TYPES = " ".join("wd:" + q for q in [
    "Q33506", "Q207694", "Q2668072", "Q588140", "Q2087181", "Q1007870", "Q570116", "Q22698", "Q167346",
    "Q1107656", "Q16970", "Q2977", "Q24398318", "Q44539", "Q32815", "Q34627", "Q16560", "Q174782",
    "Q4989906", "Q12518", "Q23413", "Q57821", "Q12280", "Q43501", "Q37654", "Q24354", "Q1060829",
    "Q483110", "Q1076486", "Q17350442", "Q1329623", "Q39614", "Q162875", "Q839954", "Q1497375",
    "Q35112127", "Q860861", "Q15243209", "Q2319498", "Q1081138", "Q8502", "Q40080",
])


def _get(url: str, params: dict | None = None, timeout: int = 30):
    r = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _sparql(query: str, timeout: int = 60) -> list[dict]:
    data = _get(SPARQL, {"query": query, "format": "json"}, timeout)
    return [{k: v["value"] for k, v in b.items()} for b in data["results"]["bindings"]]


def _cities() -> dict[str, dict]:
    return {c["code"]: c for c in _get("https://api.travelpayouts.com/data/pt/cities.json", timeout=60)}


def _countries() -> dict[str, str]:
    return {c["code"]: c["name"] for c in _get("https://api.travelpayouts.com/data/pt/countries.json")}


# ---------------------------------------------------------------------------
# Promoções saindo de cada origem
# ---------------------------------------------------------------------------
def refresh_deals(db, origins: list[str], now: datetime) -> str:
    cities, countries = _cities(), _countries()
    today = now.date()
    rows = []
    for origin in origins:
        home_country = (cities.get(origin) or {}).get("country_code")
        try:
            items = aviasales.cheapest_destinations(origin)
        except SourceError as e:
            return f"promoções: {e}"
        domestic, international = [], []
        for it in items:
            dest = it.get("destination")
            city = cities.get(dest) or {}
            dep = it.get("departure_at", "")[:10]
            if not dest or dest == origin or not dep or date.fromisoformat(dep) <= today:
                continue
            row = {
                "origin": origin, "destination": dest, "destination_label": city.get("name") or dest,
                "country_code": city.get("country_code"), "country_name": countries.get(city.get("country_code"), None),
                "depart_date": dep, "return_date": (it.get("return_at") or "")[:10] or None,
                "price": float(it["price"]), "airline": it.get("airline"),
                "stops": max(it.get("transfers") or 0, it.get("return_transfers") or 0),
                "link": f"https://www.aviasales.com{it['link'].split('?')[0]}" if it.get("link") else None,
                "found_at": now.isoformat(),
            }
            (domestic if row["country_code"] == home_country else international).append(row)
        rows += domestic[:DOMESTIC_DEALS] + international[:INTERNATIONAL_DEALS]
    db.delete("deals", {"origin": f"in.({','.join(origins)})"})
    db.insert("deals", rows)
    db.update("settings", {"id": "eq.1"}, {"deals_refreshed_at": now.isoformat()})
    return f"promoções: {len(rows)} destinos a partir de {', '.join(origins)}"


# ---------------------------------------------------------------------------
# Informações dos destinos
# ---------------------------------------------------------------------------
def _place(code: str) -> dict | None:
    items = _get("https://autocomplete.travelpayouts.com/places2",
                 {"term": code, "locale": "pt", "types[]": ["city", "airport"]})
    for it in items:
        if it.get("code") == code:
            return it
    return None


def _plain(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().casefold().strip()


def _city_item(lat: float, lon: float, name: str) -> dict | None:
    """Item do Wikidata da cidade perto das coordenadas: a de mesmo nome ou, se nenhuma, a mais conhecida."""
    rows = _sparql(f"""
SELECT DISTINCT ?city ?links ?pt ?en ?ptLabel ?enLabel WHERE {{
  SERVICE wikibase:around {{ ?city wdt:P625 ?loc . bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral ; wikibase:radius "30" . }}
  ?city wdt:P31/wdt:P279* wd:Q515 ; wikibase:sitelinks ?links .
  OPTIONAL {{ ?pt schema:about ?city ; schema:isPartOf <https://pt.wikipedia.org/> . }}
  OPTIONAL {{ ?en schema:about ?city ; schema:isPartOf <https://en.wikipedia.org/> . }}
  OPTIONAL {{ ?city rdfs:label ?ptLabel . FILTER(lang(?ptLabel) = "pt") }}
  OPTIONAL {{ ?city rdfs:label ?enLabel . FILTER(lang(?enLabel) = "en") }}
}} ORDER BY DESC(?links) LIMIT 15""")
    want = _plain(name)
    same = [r for r in rows if want in (_plain(r.get("ptLabel", "")), _plain(r.get("enLabel", "")))]
    return (same or rows or [None])[0]


def _near(a: tuple[float, float], b: tuple[float, float], km: float = 60) -> bool:
    # aproximação plana: suficiente para "mesma região"
    dlat, dlon = a[0] - b[0], (a[1] - b[1]) * math.cos(math.radians(a[0]))
    return math.hypot(dlat, dlon) * 111 <= km


def _summary_by_name(name: str, lat: float, lon: float) -> dict | None:
    """Artigo da Wikipedia em português com o nome da cidade, se for mesmo um lugar perto das coordenadas."""
    try:
        s = _get(f"https://pt.wikipedia.org/api/rest_v1/page/summary/{quote(name.replace(' ', '_'))}")
    except requests.HTTPError:
        return None
    c = s.get("coordinates")
    if s.get("type") != "standard" or not c or not _near((c["lat"], c["lon"]), (lat, lon)):
        return None
    return s


def _summary(article_url: str) -> dict:
    lang = "pt" if "//pt." in article_url else "en"
    title = article_url.rsplit("/wiki/", 1)[1]
    return _get(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}")


def _facts(qid: str, country_code: str | None) -> dict:
    rows = _sparql(f"""
SELECT ?cur ?lang ?plugLabel ?volt WHERE {{
  wd:{qid} wdt:P17 ?c .
  OPTIONAL {{ ?c p:P38 ?st . ?st ps:P38 ?ci . ?ci wdt:P498 ?cur . FILTER NOT EXISTS {{ ?st pq:P582 [] }} }}
  OPTIONAL {{ ?c wdt:P37 ?l . ?l rdfs:label ?lang . FILTER(lang(?lang) = "pt") }}
  OPTIONAL {{ ?c wdt:P2853 ?plug . }}
  OPTIONAL {{ ?c wdt:P2884 ?volt . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "pt,en". }}
}}""", timeout=30)
    pick = lambda k: sorted({r[k] for r in rows if r.get(k)})
    # unidades de conta que não circulam (ex.: CLF no Chile) ficam de fora
    currencies = [c for c in pick("cur") if c not in ACCOUNTING_UNITS]
    languages = LANGUAGE_OVERRIDES.get(country_code) or pick("lang")[:3]
    return {"currency": (currencies or [None])[0], "languages": languages,
            "plugs": pick("plugLabel"), "voltage": (pick("volt") or [None])[0]}


def _attractions(lat: float, lon: float) -> list[dict]:
    # cidades muito cadastradas (ex.: Amsterdã) estouram o tempo do Wikidata: tenta de novo num raio menor
    for radius, min_links in ((10, 8), (4, 12), (2, 15)):
        try:
            found = _attractions_query(lat, lon, radius, min_links)
            if len(found) < 6:
                # cidade menos famosa: aceita lugares que aparecem em menos Wikipedias
                more = _attractions_query(lat, lon, radius, 2)
                found += [a for a in more if a["name"] not in {f["name"] for f in found}][: 15 - len(found)]
            return found
        except requests.HTTPError as e:
            if e.response is None or e.response.status_code not in (500, 502, 503, 504):
                raise
            time.sleep(3)
    return []


def _attractions_query(lat: float, lon: float, radius: int, min_links: int) -> list[dict]:
    rows = _sparql(f"""
SELECT ?item ?itemLabel ?itemDescription ?image ?links ?loc ?pt WHERE {{
  SERVICE wikibase:around {{ ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral ; wikibase:radius "{radius}" . }}
  ?item wdt:P18 ?image ; wikibase:sitelinks ?links .
  FILTER(?links >= {min_links})
  ?item wdt:P31 ?type .
  VALUES ?type {{ {ATTRACTION_TYPES} }}
  OPTIONAL {{ ?pt schema:about ?item ; schema:isPartOf <https://pt.wikipedia.org/> . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "pt,en". }}
}} ORDER BY DESC(?links) LIMIT 60""", timeout=90)
    out, seen = [], set()
    for r in rows:
        if r["item"] in seen or r["itemLabel"].startswith("Q"):
            continue
        seen.add(r["item"])
        lon_, lat_ = r["loc"].removeprefix("Point(").rstrip(")").split()
        out.append({
            "name": r["itemLabel"], "desc": r.get("itemDescription"),
            "image": r["image"].replace("http://", "https://") + "?width=480",
            "link": r.get("pt") or f"https://www.wikidata.org/wiki/{r['item'].rsplit('/', 1)[1]}",
            "lat": float(lat_), "lon": float(lon_), "popularity": int(r["links"]),
        })
        if len(out) >= 15:
            break
    return out


def _basic(code: str, countries: dict[str, str]) -> dict | None:
    p = _place(code)
    if not p:
        return None
    lat, lon = p["coordinates"]["lat"], p["coordinates"]["lon"]
    row = {"code": code, "name": p.get("city_name") if p["type"] == "airport" else p["name"],
           "country_code": p.get("country_code"), "country_name": countries.get(p.get("country_code")) or p.get("country_name"),
           "lat": lat, "lon": lon, "updated_at": datetime.utcnow().isoformat() + "Z"}
    s = _summary_by_name(row["name"] or code, lat, lon)
    if s:
        row["qid"] = s.get("wikibase_item")
    else:
        city = _city_item(lat, lon, row["name"] or code)
        if city:
            row["qid"] = city["city"].rsplit("/", 1)[1]
            article = city.get("pt") or city.get("en")
            s = _summary(article) if article else None
    if s:
        row.update({
            "summary": s.get("extract"), "wiki_url": s.get("content_urls", {}).get("desktop", {}).get("page"),
            "image": (s.get("originalimage") or {}).get("source"), "thumb": (s.get("thumbnail") or {}).get("source"),
        })
    if row.get("qid"):
        row["facts"] = _facts(row["qid"], row["country_code"])
    return row


def refresh_destinations(db, route_codes: list[str], deadline: float) -> list[str]:
    """Prepara destinos novos (rotas primeiro, depois promoções) e pontos turísticos das rotas ou pedidos pelo app."""
    notes = []
    known = {r["code"]: r for r in db.select("destinations", {"select": "code,name,country_name,qid,lat,lon,updated_at,facts,attractions,attractions_at,attractions_requested_at,experiences,experiences_at"})}
    deal_codes = [r["destination"] for r in db.select("deals", {"select": "destination", "order": "price.asc"})]
    stale = lambda r: not r.get("updated_at") or datetime.fromisoformat(r["updated_at"].replace("Z", "+00:00")).replace(tzinfo=None) < datetime.utcnow() - DESTINATION_REFRESH
    todo = []
    requested = [c for c, r in known.items() if not r.get("lat")]  # destinos que o app pediu
    for c in route_codes + requested + deal_codes:
        if c not in todo and (c not in known or not known[c].get("lat") or stale(known[c])):
            todo.append(c)
    countries = _countries() if todo else {}
    done = 0
    for code in todo[:NEW_DESTINATIONS_PER_RUN]:
        if time.monotonic() > deadline:
            break
        try:
            row = _basic(code, countries)
            if row:
                db.upsert("destinations", row, "code")
                known[code] = {**known.get(code, {}), **row}
                done += 1
        except Exception as e:
            notes.append(f"destino {code}: {type(e).__name__}: {str(e)[:100]}")
        time.sleep(1)
    if done:
        notes.append(f"{done} destino(s) preparado(s)")

    day_old = lambda ts: ts and datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None) < datetime.utcnow() - timedelta(days=1)
    want = [c for c, r in known.items() if r.get("lat") and (
        (c in route_codes and not r.get("attractions_at"))
        or (r.get("attractions_at") and len(r.get("attractions") or []) < 6 and day_old(r["attractions_at"]))
        or (r.get("attractions_requested_at") and (not r.get("attractions_at") or r["attractions_requested_at"] > r["attractions_at"]))
    )]
    for code in want[:ATTRACTIONS_PER_RUN]:
        if time.monotonic() > deadline:
            break
        r = known[code]
        try:
            items = _attractions(r["lat"], r["lon"])
            db.upsert("destinations", {"code": code, "attractions": items, "attractions_at": datetime.utcnow().isoformat() + "Z"}, "code")
            notes.append(f"{code}: {len(items)} pontos turísticos")
        except Exception as e:
            notes.append(f"pontos turísticos {code}: {type(e).__name__}: {str(e)[:100]}")

    # passeios (GetYourGuide, Viator, Civitatis): rotas e pedidos do app, refeitos a cada 7 dias
    week_old = lambda ts: not ts or datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None) < datetime.utcnow() - EXPERIENCES_REFRESH
    # listas antigas sem "brl" vieram com preço em dólar do Viator: refaz
    stale_cur = lambda r: any(x.get("brl") != 2 for x in (r.get("experiences") or []))  # 2 = preço pedido direto em reais
    want = [c for c, r in known.items() if r.get("lat") and (week_old(r.get("experiences_at")) or stale_cur(r)) and (
        c in route_codes or r.get("attractions_requested_at") or r.get("experiences"))]
    # listas com preço em dólar (antes da correção) vêm primeiro e sem limite apertado
    want.sort(key=lambda c: not stale_cur(known[c]))
    limit = max(EXPERIENCES_PER_RUN, sum(1 for c in want if stale_cur(known[c])))
    for code in want[:min(limit, 8)]:
        if time.monotonic() > deadline:
            break
        r = known[code]
        try:
            items, problems = experiences.search([r.get("name"), _english_name(r.get("qid"))])
            db.upsert("destinations", {"code": code, "experiences": items, "experiences_at": datetime.utcnow().isoformat() + "Z"}, "code")
            notes.append(f"{code}: {len(items)} passeios" + (f" ({'; '.join(problems)})" if problems else ""))
        except Exception as e:
            notes.append(f"passeios {code}: {type(e).__name__}: {str(e)[:100]}")

    # estimativa de custo diário (hotel, comida, transporte) para a conta do guia
    if os.environ.get("GEMINI_API_KEY"):
        need = [c for c, r in known.items() if r.get("lat") and r.get("facts") is not None and not (r.get("facts") or {}).get("costs")
                and (c in route_codes or r.get("attractions_at"))]
        for code in need[:COSTS_PER_RUN]:
            if time.monotonic() > deadline:
                break
            r = known[code]
            try:
                facts = {**(r.get("facts") or {}), "costs": ai.cost_estimates(r.get("name") or code, r.get("country_name") or "")}
                db.upsert("destinations", {"code": code, "facts": facts}, "code")
                notes.append(f"{code}: custos estimados")
            except Exception as e:
                notes.append(f"custos {code}: {str(e)[:100]}")
    return notes


def _english_name(qid: str | None) -> str | None:
    if not qid:
        return None
    try:
        return _get(f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json")["entities"][qid]["labels"]["en"]["value"]
    except Exception:
        return None


def run(db, routes: list[dict], settings: dict, now: datetime, deadline: float) -> list[str]:
    """Manutenção do Explorar; roda em toda rodada e só trabalha quando há algo vencido."""
    notes = []
    origins = sorted({r["origin"] for r in routes if r.get("active")} | {DEFAULT_ORIGIN})
    last = settings.get("deals_refreshed_at")
    if not last or datetime.fromisoformat(last.replace("Z", "+00:00")) < now - DEALS_EVERY:
        try:
            notes.append(refresh_deals(db, origins, now))
        except Exception as e:
            notes.append(f"promoções: {type(e).__name__}: {str(e)[:150]}")
    route_codes = list(dict.fromkeys(r["destination"] for r in routes if r.get("active")))
    try:
        notes += refresh_destinations(db, route_codes, deadline)
    except Exception as e:
        notes.append(f"destinos: {type(e).__name__}: {str(e)[:150]}")
    return notes
