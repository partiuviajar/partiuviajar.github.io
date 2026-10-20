"""IA gratuita (Google Gemini, plano grátis) para respostas em JSON.

No plano grátis o Google às vezes responde "alta demanda" (503): por isso tenta vários
modelos e repete com espera antes de desistir.
"""

import json
import os
import time

import requests

GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
WAITS = [0, 15, 30, 60]  # segundos antes de cada rodada pela lista de modelos


def generate_json(prompt: str, schema: dict, temperature: float = 0.7, rounds: int = len(WAITS)) -> dict:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY não configurada")
    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema, "temperature": temperature}}
    last = None
    for rnd in range(rounds):
        time.sleep(WAITS[min(rnd, len(WAITS) - 1)])
        for model in GEMINI_MODELS:
            try:
                r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                  headers={"x-goog-api-key": key}, json=body, timeout=120)
                d = r.json()
                if "candidates" not in d:
                    raise RuntimeError(str((d.get("error") or {}).get("message") or d)[:160])
                out = json.loads(d["candidates"][0]["content"]["parts"][0]["text"])
                if isinstance(out, dict):
                    out["_model"] = model
                return out
            except Exception as e:
                last = e
                print(f"[gemini] rodada {rnd + 1} {model}: {str(e)[:120]}")
    raise RuntimeError(f"A IA está sobrecarregada agora. Tente de novo em alguns minutos. ({str(last)[:80]})")


COST_SCHEMA = {
    "type": "object",
    "properties": {
        "hotel_night_double": {"type": "integer"},
        "food_day": {"type": "integer"},
        "transport_day": {"type": "integer"},
    },
    "required": ["hotel_night_double", "food_day", "transport_day"],
}


def cost_estimates(city: str, country: str) -> dict:
    """Custo diário típico em reais: diária de hotel 3–4★ (quarto duplo), comida e transporte por pessoa."""
    out = generate_json(
        f"""Estime custos típicos atuais de turismo em {city}, {country}, em reais (BRL), para um viajante brasileiro de orçamento médio.
- hotel_night_double: diária de um hotel 3 a 4 estrelas bem avaliado, quarto duplo (o quarto inteiro).
- food_day: comida por pessoa por dia (café simples, almoço e jantar em restaurantes comuns).
- transport_day: transporte local por pessoa por dia (metrô/ônibus/apps, média).
Responda só com números inteiros realistas.""",
        COST_SCHEMA, temperature=0.2, rounds=2)
    return {k: int(out[k]) for k in ("hotel_night_double", "food_day", "transport_day")} | {"source": "estimativa IA", "model": out.get("_model")}
