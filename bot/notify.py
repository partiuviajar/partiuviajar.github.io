"""Envio de avisos: WhatsApp (CallMeBot), Telegram e notificação do app (Web Push)."""

import json
import os
import time
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


MAX_MESSAGES_PER_ALERT = 3   # uma mensagem por passagem; mais que isso o CallMeBot pode bloquear
PAUSE_BETWEEN_MESSAGES = 4    # segundos entre mensagens do mesmo alerta


def price_text(route: dict, price: float) -> str:
    """Preço total e, com mais de 1 adulto, por pessoa."""
    adults = route.get("adults") or 1
    return f"*{brl(price)}*" + (f" · {brl(price / adults)}/pessoa" if adults > 1 else "")


def alert_messages(route: dict, items: list[dict]) -> tuple[str, list[str]]:
    """Monta (título curto, mensagens): uma mensagem curta por passagem, cada uma com o próprio link de compra.

    Mensagens pequenas não são cortadas pelo CallMeBot (que manda o texto dentro do link).
    """
    if route["date_mode"] == "long":
        kind = "viagem longa"
    else:
        kind = "ida e volta" if route["trip_type"] == "round_trip" else "só ida"
    pax = f" · {route['adults']} adultos" if route["adults"] > 1 else ""
    items = items[:MAX_MESSAGES_PER_ALERT]
    title = f"✈️ {route_title(route)} por {brl(items[0]['price'])}"
    url = app_url(f"#/rota/{route['id']}")
    messages = []
    for i, it in enumerate(items, 1):
        count = f" ({i}/{len(items)})" if len(items) > 1 else ""
        lines = [f"✈️ *Preço baixo: {route_title(route)}*{count}", f"{kind}{pax}"]
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
        price_line = f"💰 {price_text(route, it['price'])}"
        if it.get("normal_price"):
            price_line += f" (normal ~{brl(it['normal_price'])})"
        lines.append(price_line)
        details = [x for x in [it.get("airline"), stops_label(it.get("stops"))] if x]
        lines.append("✅ " + " · ".join(details + ["; ".join(it["reasons"])]))
        if it.get("google_link_back"):
            lines += [f"🛒 Ida: {it['google_link']}", f"🛒 Volta: {it['google_link_back']}"]
        elif it.get("google_link"):
            lines.append(f"🛒 Comprar: {it['google_link']}")
        if i == len(items) and url:
            lines.append(f"📊 Ver tudo no app: {url}")
        messages.append("\n".join(lines))
    return title, messages


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


def send_all(send, messages: list[str]) -> bool:
    """Envia várias mensagens em sequência, com pausa entre elas. True se ao menos uma chegou."""
    ok = False
    for i, text in enumerate(messages):
        if i:
            time.sleep(PAUSE_BETWEEN_MESSAGES)
        ok = send(text) or ok
    return ok


def broadcast(db, settings: dict, title: str, text: str | list[str], url: str = "") -> list[str]:
    """Envia para todos os canais ligados (uma ou várias mensagens). Devolve os canais que funcionaram."""
    messages = [text] if isinstance(text, str) else text
    used = []
    if settings.get("notify_whatsapp", True) and send_all(send_whatsapp, messages):
        used.append("whatsapp")
    if settings.get("notify_telegram", True) and send_all(send_telegram, messages):
        used.append("telegram")
    if settings.get("notify_push", True):
        # notificação do app: uma só, com a primeira passagem
        body = messages[0].replace("*", "").split("\n", 1)[-1]
        if send_push(db, title, body, url):
            used.append("push")
    return used
