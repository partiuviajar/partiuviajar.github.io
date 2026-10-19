"""Envio de avisos: WhatsApp (CallMeBot), Telegram e notificação do app (Web Push)."""

import json
import os
from datetime import date

import requests

WEEKDAYS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]


def brl(value: float | None) -> str:
    if value is None:
        return "-"
    return "R$ " + f"{value:,.0f}".replace(",", ".")


def fmt_day(d: date | str | None) -> str:
    if d is None:
        return ""
    if isinstance(d, str):
        d = date.fromisoformat(d)
    return f"{d:%d/%m} ({WEEKDAYS[d.weekday()]})"


def stops_label(stops: int | None) -> str:
    if stops is None:
        return ""
    return "direto" if stops == 0 else f"{stops} escala" + ("s" if stops > 1 else "")


def app_url(path: str = "") -> str:
    base = os.environ.get("APP_URL", "").rstrip("/")
    return f"{base}/{path}" if base else ""


def channels_status() -> dict:
    return {
        "whatsapp": bool(os.environ.get("CALLMEBOT_PHONE") and os.environ.get("CALLMEBOT_APIKEY")),
        "telegram": bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")),
        "push": bool(os.environ.get("VAPID_PRIVATE_KEY")),
    }


def route_title(route: dict) -> str:
    o = route.get("origin_label") or route["origin"]
    d = route.get("destination_label") or route["destination"]
    return f"{o} → {d}"


def leg_title(route: dict, item: dict) -> str | None:
    """Rótulo do trecho na viagem longa (None nas rotas comuns)."""
    o = route.get("origin_label") or route["origin"]
    d = route.get("destination_label") or route["destination"]
    label = {
        "out": f"🛫 Só ida ({o} → {d})",
        "back": f"🛬 Só volta ({d} → {o})",
        "rt": "🔁 Ida e volta na mesma passagem",
        "combo": "🧩 Viagem toda com 2 passagens só de ida",
    }.get(item.get("leg"))
    if label and item.get("direct_only"):
        label += " · só voos diretos"
    return label


def alert_message(route: dict, items: list[dict]) -> tuple[str, str]:
    """Monta (título curto, texto completo) para um conjunto de datas baratas da mesma rota."""
    if route["date_mode"] == "long":
        kind = "viagem longa"
    else:
        kind = "ida e volta" if route["trip_type"] == "round_trip" else "só ida"
    pax = f" · {route['adults']} adultos" if route["adults"] > 1 else ""
    best = items[0]
    title = f"✈️ {route_title(route)} por {brl(best['price'])}"
    lines = [f"✈️ *Radar de Voos: preço baixo!*", f"{route_title(route)} · {kind}{pax}", ""]
    for it in items:
        leg = leg_title(route, it)
        if leg:
            lines.append(f"*{leg}*")
        days = fmt_day(it["depart_date"])
        if it.get("return_date"):
            days += f" → {fmt_day(it['return_date'])}"
            if it.get("leg"):
                stay = (date.fromisoformat(str(it["return_date"])) - date.fromisoformat(str(it["depart_date"]))).days
                days += f" · {stay} dias"
        lines.append(f"📅 {days}")
        price_line = f"💰 *{brl(it['price'])}*"
        if it.get("normal_price"):
            price_line += f" (normal ~{brl(it['normal_price'])})"
        lines.append(price_line)
        source = {"google": "Google Flights", "aviasales": "Aviasales"}.get(it.get("source"))
        details = [x for x in [it.get("airline"), stops_label(it.get("stops")), source] if x]
        lines.append("🏷️ " + " · ".join(details))
        lines.append("✅ " + "; ".join(it["reasons"]))
        if it.get("google_link_back"):
            lines.append(f"🛒 Ida (Google Flights): {it['google_link']}")
            lines.append(f"🛒 Volta (Google Flights): {it['google_link_back']}")
        elif it.get("google_link"):
            lines.append(f"🛒 Comprar (Google Flights): {it['google_link']}")
        if it.get("aviasales_link"):
            lines.append(f"🛒 Comprar (Aviasales): {it['aviasales_link']}")
        lines.append("")
    url = app_url(f"#/rota/{route['id']}")
    if url:
        lines.append(f"📊 Ver no app: {url}")
    return title, "\n".join(lines).strip()


def send_whatsapp(text: str) -> bool:
    phone, key = os.environ.get("CALLMEBOT_PHONE"), os.environ.get("CALLMEBOT_APIKEY")
    if not (phone and key):
        return False
    try:
        r = requests.get(
            "https://api.callmebot.com/whatsapp.php",
            params={"phone": phone, "text": text, "apikey": key},
            timeout=40,
        )
        ok = r.status_code == 200 and "error" not in r.text.lower()
        if not ok:
            print(f"[whatsapp] falhou {r.status_code}: {r.text[:200]}")
        return ok
    except Exception as e:
        print(f"[whatsapp] erro: {e}")
        return False


def send_telegram(text: str) -> bool:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return False
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat, "text": text.replace("*", ""), "disable_web_page_preview": True},
            timeout=30,
        )
        if r.status_code != 200:
            print(f"[telegram] falhou {r.status_code}: {r.text[:200]}")
        return r.status_code == 200
    except Exception as e:
        print(f"[telegram] erro: {e}")
        return False


def send_push(db, title: str, body: str, url: str) -> bool:
    private_key = os.environ.get("VAPID_PRIVATE_KEY")
    if not private_key:
        return False
    from pywebpush import WebPushException, webpush

    subs = db.select("push_subscriptions")
    payload = json.dumps({"title": title, "body": body[:240], "url": url or "./"})
    sent = False
    for s in subs:
        try:
            webpush(
                subscription_info={"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                data=payload,
                vapid_private_key=private_key,
                vapid_claims={"sub": os.environ.get("VAPID_SUBJECT", "mailto:radar@example.com")},
                ttl=24 * 3600,
            )
            sent = True
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):  # aparelho desinscrito
                db.delete("push_subscriptions", {"endpoint": f"eq.{s['endpoint']}"})
            else:
                print(f"[push] falhou {status}: {str(e)[:200]}")
        except Exception as e:
            print(f"[push] erro: {e}")
    return sent


def broadcast(db, settings: dict, title: str, text: str, url: str = "") -> list[str]:
    """Envia para todos os canais ligados. Devolve os canais que funcionaram."""
    used = []
    if settings.get("notify_whatsapp", True) and send_whatsapp(text):
        used.append("whatsapp")
    if settings.get("notify_telegram", True) and send_telegram(text):
        used.append("telegram")
    if settings.get("notify_push", True):
        body = text.replace("*", "").split("\n", 2)[-1]
        if send_push(db, title, body, url):
            used.append("push")
    return used
