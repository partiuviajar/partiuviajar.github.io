"""Passeios e experiências com preço em reais: GetYourGuide, Viator e Civitatis (páginas públicas de busca).

O Google tinha uma página de "coisas para fazer" que juntava esses sites, mas ela foi desativada.
GetYourGuide e Viator recusam requisições simples, por isso o curl_cffi se passa por um Chrome.
"""

import json
import re
import time
from urllib.parse import quote

from curl_cffi import requests

URLS = {
    "GetYourGuide": "https://www.getyourguide.com/pt-br/s/?q={q}",
    "Viator": "https://www.viator.com/pt-BR/searchResults/all?text={q}",   # costuma redirecionar para /pt-BR/<Cidade>/d<id>-ttd
    "Civitatis": "https://www.civitatis.com/br/procurar?q={q}",             # redireciona para /br/<cidade>/
}
PER_SOURCE = 8
_RATES: dict | None = None


def to_brl(amount, currency: str | None) -> float | None:
    """Converte para real pela cotação do dia (o Viator responde em dólar mesmo no site brasileiro)."""
    global _RATES
    v = _num(amount)
    if v is None:
        return None
    cur = (currency or "BRL").upper()
    if cur == "BRL":
        return v
    if _RATES is None:
        try:
            _RATES = requests.get("https://open.er-api.com/v6/latest/BRL", timeout=20).json().get("rates") or {}
        except Exception:
            _RATES = {}
    rate = _RATES.get(cur)
    return round(v / rate, 2) if rate else None
MAX_ITEMS = 18


def _ld_blocks(html: str):
    for b in re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', html, re.S):
        try:
            yield json.loads(b, strict=False)
        except ValueError:
            pass


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


NOT_TOURS = re.compile(r"seguro|chip|e-?sim|cart[aã]o sim", re.I)  # o Civitatis mistura produtos que não são passeios


def _item(provider, title, price, rating, reviews, photo, link, currency="BRL") -> dict | None:
    if not title or not link or NOT_TOURS.search(title):
        return None
    rating = _num(rating)
    return {"provider": provider, "title": title, "price": to_brl(price, currency), "brl": True, "rating": round(rating, 2) if rating else None,
            "reviews": int(_num(reviews) or 0), "photo": photo, "link": link}


def _gyg(html: str) -> list[dict]:
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(.*?)</script>", html, re.S)
    if not m:
        return []
    state = json.JSONDecoder().raw_decode(m.group(1).strip().rstrip(";"))[0]
    seen, out = set(), []

    def walk(o):
        if isinstance(o, dict):
            if "tour_id" in o and "price" in o and "title" in o and o["tour_id"] not in seen and o.get("url"):
                seen.add(o["tour_id"])
                urls = ((o.get("photos") or [{}])[0].get("urls") or [])
                photo = next((u["url"] for u in urls if u.get("size") == "medium"), urls[0]["url"] if urls else None)
                r = o.get("review_statistics") or {}
                out.append(_item("GetYourGuide", o["title"], (o["price"] or {}).get("starting_price"), r.get("rating"),
                                 r.get("quantity"), photo, "https://www.getyourguide.com/pt-br" + o["url"]))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(state)
    return out


def _viator(html: str) -> list[dict]:
    out = []
    m = re.search(r'<script[^>]*id="globalState"[^>]*>(.*?)</script>', html, re.S)
    if m:
        try:
            res = json.loads(m.group(1))["__PRELOADED_DATA__"]["pageModel"]["preloadedData"]["search"]["results"]
        except (KeyError, TypeError, ValueError):
            res = []
        for r in res or []:
            it = r.get("item") or {}
            code = it.get("productCode")
            if not code:
                continue
            href = re.search(r'href="(/pt-BR/tours/[^"?]+-%s)"' % re.escape(code), html)
            sizes = (it.get("defaultPhoto") or {}).get("sizes") or []
            rs = it.get("reviewSummary") or {}
            fp = (it.get("pricingInfo") or {}).get("fromPrice") or {}
            out.append(_item("Viator", (it.get("title") or {}).get("text"), fp.get("amount"),
                             rs.get("exactRating"), rs.get("count"), next((z["url"] for z in sizes if z.get("width") == 480), None),
                             "https://www.viator.com" + href.group(1) if href else None, fp.get("currency") or "USD"))
        if out:
            return out
    for j in _ld_blocks(html):
        items = ((j.get("subjectOf") or {}).get("mainEntity") or {}).get("itemListElement") if isinstance(j, dict) else None
        for li in items or []:
            it = li.get("item") or {}
            ar = it.get("aggregateRating") or {}
            image = it.get("image")
            offer = it.get("offers") or {}
            out.append(_item("Viator", it.get("name"), offer.get("price"), ar.get("ratingValue"),
                             ar.get("reviewCount"), image[0] if isinstance(image, list) else image, it.get("url"), offer.get("priceCurrency") or "USD"))
    return out


def _civitatis(html: str) -> list[dict]:
    out = []
    for j in _ld_blocks(html):
        if isinstance(j, dict) and j.get("@type") == "ItemList":
            for li in j.get("itemListElement") or []:
                it = li.get("item") or {}
                ar = it.get("aggregateRating") or {}
                rating = _num(ar.get("ratingValue"))
                image = it.get("image")
                # nota de 0 a 10 vira 0 a 5; o preço já vem em reais no site brasileiro (a moeda informada no JSON é errada)
                out.append(_item("Civitatis", it.get("name"), (it.get("offers") or {}).get("price"), rating / 2 if rating else None,
                                 ar.get("reviewCount"), image[0] if isinstance(image, list) else image, it.get("url")))
    return out


PARSERS = {"GetYourGuide": _gyg, "Viator": _viator, "Civitatis": _civitatis}


def search(names: list[str]) -> tuple[list[dict], list[str]]:
    """Passeios mais avaliados da cidade, misturando os três sites. Devolve (itens, avisos).

    `names`: nomes da cidade a tentar em ordem (ex.: "Amesterdão", "Amsterdam"); cada site usa o primeiro que der resultado.
    """
    session = requests.Session(impersonate="chrome")
    session.headers["Accept-Language"] = "pt-BR,pt;q=0.9"
    found, notes = [], []
    names = list(dict.fromkeys(n for n in names if n))
    for name, url in URLS.items():
        items, error = [], None
        for city in names:
            time.sleep(2)
            try:
                r = session.get(url.format(q=quote(city)), timeout=30)
                r.raise_for_status()
                items = [x for x in PARSERS[name](r.text) if x and x["price"]]
            except Exception as e:
                error = f"{type(e).__name__}: {str(e)[:80]}"
            if items:
                break
        # os mais avaliados de cada site
        found += sorted(items, key=lambda x: x["reviews"], reverse=True)[:PER_SOURCE]
        if not items:
            notes.append(f"{name}: {error or 'nenhum passeio lido'}")
    found.sort(key=lambda x: x["reviews"], reverse=True)
    return found[:MAX_ITEMS], notes
