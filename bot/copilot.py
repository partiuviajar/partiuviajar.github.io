"""Copiloto ✨: 2 sugestões de viagem que cabem no orçamento, a partir de um questionário.

Fluxo: o app grava as respostas em copilot_requests; o Supabase dispara o workflow "Copiloto",
que roda este script. Os preços vêm de dados reais (passagens da Travelpayouts, hotéis do
Google Hotels, clima da Open-Meteo); a IA (Gemini, plano grátis) só escolhe entre destinos
que já cabem no bolso e escreve o porquê, o roteiro e as dicas.
Uso: python copilot.py <id do pedido>
"""

import json
import os
import re
import sys
import time
import traceback
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import median

import requests

import ai
import explore
import hotels
import notify
from db import DB
from sources import aviasales

MAX_CANDIDATES = 18
RG_COUNTRIES = {"BR", "AR", "UY", "PY", "CL", "BO", "PE", "CO", "EC", "VE"}
VISA_US = {"US", "CA"}  # Canadá aceita eTA para quem tem visto americano


def months_between(a: date, b: date) -> list[date]:
    out, cur = [], a.replace(day=1)
    while cur <= b:
        out.append(cur)
        cur = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


# ---------------------------------------------------------------------------
# 1) Destinos com passagem real dentro das datas, duração e orçamento
# ---------------------------------------------------------------------------
def candidates(a: dict, cities: dict, countries: dict) -> list[dict]:
    origin = a.get("origin") or "RIO"
    d_from, d_to = date.fromisoformat(a["date_from"]), date.fromisoformat(a["date_to"])
    min_days, max_days = int(a.get("min_days") or 3), int(a.get("max_days") or 10)
    people = int(a.get("adults") or 1) + int(a.get("children") or 0)
    budget = float(a["budget"])
    scope = a.get("scope") or "any"
    best: dict[str, dict] = {}
    chosen = sorted(a.get("months") or [])  # meses escolhidos no app (a ida acontece dentro deles)
    months = [date.fromisoformat(m + "-01") for m in chosen] or months_between(d_from, d_to)
    for m in months:
        try:
            items = aviasales._fetch({"origin": origin, "departure_at": m.strftime("%Y-%m"), "one_way": "false", "unique": "false"})
        except Exception as e:
            print(f"[passagens] {m}: {e}")
            continue
        for it in items:
            dest = it.get("destination")
            dep = (it.get("departure_at") or "")[:10]
            ret = (it.get("return_at") or "")[:10]
            if not dest or not dep or not ret or dest == origin:
                continue
            dd, rr = date.fromisoformat(dep), date.fromisoformat(ret)
            days = (rr - dd).days
            if dd < d_from or rr > d_to or not (min_days <= days <= max_days):
                continue
            if chosen and dep[:7] not in chosen:
                continue
            cc = (cities.get(dest) or {}).get("country_code")
            if scope == "national" and cc != "BR":
                continue
            if scope == "international" and cc == "BR":
                continue
            if not a.get("passport") and cc not in RG_COUNTRIES:
                continue
            if not a.get("us_visa") and cc in VISA_US:
                continue
            total = float(it["price"]) * people
            if total > budget * 0.6:  # a passagem não pode comer mais de 60% do orçamento
                continue
            if dest not in best or total < best[dest]["flight_total"]:
                c = cities.get(dest) or {}
                best[dest] = {
                    "code": dest, "city": c.get("name") or dest, "country": countries.get(cc, cc), "country_code": cc,
                    "lat": (c.get("coordinates") or {}).get("lat"), "lon": (c.get("coordinates") or {}).get("lon"),
                    "depart": dep, "return": ret, "days": days, "flight_total": round(total),
                    "flight_per_person": round(float(it["price"])), "airline": it.get("airline"),
                    "stops": max(it.get("transfers") or 0, it.get("return_transfers") or 0),
                }
        time.sleep(0.5)
    return sorted(best.values(), key=lambda x: x["flight_total"])


# ---------------------------------------------------------------------------
# 2) Clima real nas datas (mesmo período do ano passado)
# ---------------------------------------------------------------------------
def climate(c: dict) -> dict | None:
    if c.get("lat") is None:
        return None
    shift = lambda iso: (date.fromisoformat(iso) - timedelta(days=364)).isoformat()
    try:
        r = requests.get("https://archive-api.open-meteo.com/v1/archive", params={
            "latitude": c["lat"], "longitude": c["lon"], "start_date": shift(c["depart"]), "end_date": shift(c["return"]),
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum", "timezone": "auto"}, timeout=20)
        t = r.json()["daily"]
        n = len(t["time"])
        return {"tmax": round(sum(t["temperature_2m_max"]) / n), "tmin": round(sum(t["temperature_2m_min"]) / n),
                "rain_days": sum(1 for v in t["precipitation_sum"] if (v or 0) >= 1), "days": n}
    except Exception:
        return None


def climate_score(a: dict, cl: dict | None) -> float:
    if not cl:
        return 0
    want = a.get("climate") or "any"
    s = -cl["rain_days"] / max(cl["days"], 1)  # menos chuva é melhor
    if want == "hot":
        s += 1 if cl["tmax"] >= 27 else 0.3 if cl["tmax"] >= 23 else -1
    elif want == "mild":
        s += 1 if 15 <= cl["tmax"] <= 27 else -0.5
    elif want == "cold":
        s += 1 if cl["tmax"] <= 14 else 0.3 if cl["tmax"] <= 19 else -1
        if a.get("snow"):
            s += 1 if cl["tmin"] <= 0 else -0.5
    return s


# ---------------------------------------------------------------------------
# 3) IA: escolhe 2 e escreve (Gemini, plano grátis)
# ---------------------------------------------------------------------------
OPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "code": {"type": "string"},
        "headline": {"type": "string"},
        "why": {"type": "string"},
        "vibe": {"type": "array", "items": {"type": "string"}},
        "match": {"type": "integer"},
        "itinerary": {"type": "array", "items": {"type": "object", "properties": {"day": {"type": "string"}, "title": {"type": "string"}, "text": {"type": "string"}}, "required": ["day", "title", "text"]}},
        "food_per_person_day": {"type": "integer"},
        "transport_per_person_day": {"type": "integer"},
        "activities_per_person_total": {"type": "integer"},
        "hotel_per_night_estimate": {"type": "integer"},
        "tips": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["code", "headline", "why", "vibe", "match", "itinerary", "food_per_person_day", "transport_per_person_day", "activities_per_person_total", "hotel_per_night_estimate", "tips"],
}
RESULT_SCHEMA = {"type": "object", "properties": {"intro": {"type": "string"}, "options": {"type": "array", "items": OPTION_SCHEMA}}, "required": ["intro", "options"]}

LABELS = {"hot": "calor", "mild": "clima ameno", "cold": "frio", "any": "tanto faz",
          "yes": "sim", "no": "não", "party": "praia com agito", "calm": "praia sossegada",
          "national": "só Brasil", "international": "só exterior", "fast": "ritmo intenso, ver muita coisa", "slow": "ritmo tranquilo"}


def ask_gemini(a: dict, cands: list[dict]) -> dict:
    people = int(a.get("adults") or 1) + int(a.get("children") or 0)
    profile = {
        "orcamento_total_reais": a["budget"], "pessoas": {"adultos": a.get("adults"), "criancas": a.get("children") or 0},
        "clima": LABELS.get(a.get("climate"), a.get("climate")), "quer_neve": bool(a.get("snow")),
        "praia": LABELS.get(a.get("beach"), a.get("beach")), "tipo_de_praia": LABELS.get(a.get("beach_vibe"), a.get("beach_vibe")),
        "gosta_de": a.get("interests") or [], "ritmo": LABELS.get(a.get("pace"), a.get("pace")), "observacao": (a.get("notes") or "")[:300],
    }
    prompt = f"""Você é o Copiloto, consultor de viagens do app Radar de Voos. Escreva em português do Brasil, tom animado e direto.

Perfil do viajante (JSON): {json.dumps(profile, ensure_ascii=False)}

Destinos possíveis (JSON). Todos já têm passagem de ida e volta com preço REAL encontrado, para {people} pessoa(s), nas datas indicadas, e cabem no orçamento. "clima" é o tempo real no mesmo período do ano passado (tmax/tmin em °C, dias com chuva):
{json.dumps(cands, ensure_ascii=False)}

Tarefa:
- Escolha os 2 destinos que mais combinam com o perfil (clima, praia, gostos, ritmo) e que deixam folga no orçamento para hospedagem, comida e passeios. Use somente códigos da lista ("code"). Prefira 2 destinos diferentes entre si.
- Considere o que você sabe de cada cidade (tem praia? neve? vida noturna? custo de vida?).
- Para cada um: "headline" (frase curta e chamativa, até 60 caracteres), "why" (2 a 3 frases ligando o destino ao perfil e ao clima real das datas), "vibe" (3 a 4 palavras-chave), "match" (0 a 100), "itinerary" (um item por dia ou bloco de dias, no máximo 7 itens, "day" ex.: "Dia 1" ou "Dias 2–3"), estimativas realistas em reais POR PESSOA de "food_per_person_day", "transport_per_person_day" e "activities_per_person_total" (passeios pagos da viagem toda), "hotel_per_night_estimate" (diária de um hotel bom e bem avaliado para o grupo todo) e "tips" (3 dicas práticas e específicas).
- "intro": 1 frase resumindo a escolha.
- Não invente preços de passagem: eles já estão na lista."""
    out = ai.generate_json(prompt, RESULT_SCHEMA)
    out["model"] = out.pop("_model", None)
    return out


# ---------------------------------------------------------------------------
# 4) Hotel real (Google Hotels) e conta final
# ---------------------------------------------------------------------------
def real_hotel(city: str, dep: str, ret: str, people: int, max_night: float | None = None) -> dict | None:
    """Diária típica de um hotel bem avaliado (nota 4+); com max_night, o melhor que cabe nesse teto."""
    try:
        ts = hotels.make_ts(date.fromisoformat(dep), date.fromisoformat(ret), max(1, min(people, 6)))
        found = [h for h in hotels.search_list(city, ts) if h.get("night")]
        if not found:
            return None
        good = [h for h in found if (h.get("rating") or 0) >= 4] or found
        nights = sorted(h["night"] for h in good)
        target = median(nights)
        if max_night is not None:
            fit = [h for h in good if h["night"] <= max_night]
            if fit:
                pick = max(fit, key=lambda h: (h.get("rating") or 0, h["night"]))
                return {"per_night": pick["night"], "example": pick["name"], "rating": pick.get("rating"), "count": len(good), "adjusted": True}
            target = nights[0]
        pick = sorted(good, key=lambda h: abs(h["night"] - target))[0]
        return {"per_night": round(target), "example": pick["name"], "rating": pick.get("rating"), "count": len(good)}
    except Exception as e:
        print(f"[hotel] {city}: {e}")
        return None


def run(db: DB, req_id: str):
    req = (db.select("copilot_requests", {"id": f"eq.{req_id}"}) or [None])[0]
    if not req:
        print("pedido não encontrado")
        return
    now = lambda: datetime.now(timezone.utc).isoformat()
    upd = lambda **v: db.update("copilot_requests", {"id": f"eq.{req_id}"}, v)
    upd(status="running", stage="Buscando passagens reais nas suas datas…")
    a = req["answers"]
    try:
        cities, countries = explore._cities(), explore._countries()
        cands = candidates(a, cities, countries)
        print(f"{len(cands)} destinos com passagem dentro do orçamento")
        if not cands:
            upd(status="done", finished_at=now(), result={"empty": True, "reason": "Não achamos passagens que caibam nesse orçamento e nessas datas. Tente aumentar o orçamento, abrir mais as datas ou aceitar outros tipos de destino."})
            return
        upd(stage="Conferindo o clima real de cada destino…")
        pool = cands[:40]
        for c in pool:
            c["clima"] = climate(c)
            time.sleep(0.2)
        pool.sort(key=lambda c: (-climate_score(a, c["clima"]), c["flight_total"]))
        chosen = pool[:MAX_CANDIDATES]
        for c in chosen:
            c.pop("lat", None); c.pop("lon", None)
        upd(stage="O Copiloto está escolhendo as 2 melhores viagens…")
        ai = ask_gemini(a, chosen)
        by_code = {c["code"]: c for c in chosen}
        people = int(a.get("adults") or 1) + int(a.get("children") or 0)
        options = []
        upd(stage="Conferindo preços reais de hotel…")
        for o in ai.get("options", []):
            c = by_code.get(o.get("code"))
            if not c or any(x["code"] == c["code"] for x in options):
                continue
            nights = c["days"]
            hotel = real_hotel(c["city"], c["depart"], c["return"], people)
            per_night = hotel["per_night"] if hotel else int(o.get("hotel_per_night_estimate") or 0)
            cost = {
                "flight": c["flight_total"],
                "hotel": per_night * nights,
                "food": int(o.get("food_per_person_day") or 0) * people * nights,
                "transport": int(o.get("transport_per_person_day") or 0) * people * nights,
                "activities": int(o.get("activities_per_person_total") or 0) * people,
            }
            total = sum(cost.values())
            if hotel and total > float(a["budget"]):
                # estourou: procura um hotel bem avaliado que caiba no que sobra
                room = (float(a["budget"]) - (total - cost["hotel"])) / max(nights, 1)
                cheaper = real_hotel(c["city"], c["depart"], c["return"], people, max_night=room) if room > 0 else None
                if cheaper and cheaper["per_night"] < per_night:
                    hotel, per_night = cheaper, cheaper["per_night"]
                    cost["hotel"] = per_night * nights
                    total = sum(cost.values())
            dest = explore._basic(c["code"], countries)  # foto e resumo para o app
            if dest:
                db.upsert("destinations", dest, "code")
            options.append({**o, **{k: c[k] for k in ("code", "city", "country", "country_code", "depart", "return", "days", "airline", "stops", "flight_per_person")},
                            "clima": c.get("clima"), "hotel": hotel, "hotel_real": bool(hotel), "cost": cost, "total": total,
                            "per_person": round(total / people), "fits": total <= float(a["budget"]),
                            "photo": (dest or {}).get("thumb")})
            if len(options) == 2:
                break
        result = {"intro": ai.get("intro"), "options": options, "model": ai.get("model"), "considered": len(cands)}
        upd(status="done", finished_at=now(), result=result, stage=None)
        print(f"pronto: {[o['city'] for o in options]} ({ai.get('model')})")
        settings = (db.select("settings", {"id": "eq.1"}) or [{}])[0]
        url = notify.app_url(f"#/copiloto/{req_id}")
        names = " e ".join(o["city"] for o in options) or "suas sugestões"
        text = f"✨ *Copiloto: suas viagens sob medida estão prontas!*\n{names}, cabendo no seu orçamento."
        if url:
            text += f"\n👉 Ver: {url}"
        notify.broadcast(db, settings, "✨ Copiloto: viagens prontas", text, url)
    except Exception as e:
        traceback.print_exc()
        upd(status="error", error=str(e)[:300], stage=None)


if __name__ == "__main__":
    rid = sys.argv[1] if len(sys.argv) > 1 else ""
    if not re.fullmatch(r"[0-9a-f-]{36}", rid):
        sys.exit("uso: python copilot.py <uuid do pedido>")
    run(DB(), rid)
