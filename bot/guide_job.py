"""Prepara um guia de destino sob demanda e avisa quando fica pronto.

O app grava um pedido em guide_requests; o Supabase dispara o workflow "Preparar guia",
que roda este script: foto e resumo, pontos turísticos e passeios. No fim, manda a
notificação (app/WhatsApp/Telegram) com o link do guia.
Uso: python guide_job.py <id do pedido>
"""

import re
import sys
import traceback
from datetime import datetime, timezone

import experiences
import explore
import notify
from db import DB


def run(db: DB, req_id: str):
    req = (db.select("guide_requests", {"id": f"eq.{req_id}"}) or [None])[0]
    if not req:
        print("pedido não encontrado")
        return
    code = req["code"]
    now = lambda: datetime.now(timezone.utc).isoformat()
    db.update("guide_requests", {"id": f"eq.{req_id}"}, {"status": "running"})
    try:
        row = explore._basic(code, explore._countries())
        if not row:
            raise RuntimeError(f"cidade {code} não encontrada")
        db.upsert("destinations", row, "code")
        name = row.get("name") or req.get("name") or code
        try:
            items = explore._attractions(row["lat"], row["lon"])
            db.upsert("destinations", {"code": code, "attractions": items, "attractions_at": now()}, "code")
            print(f"{len(items)} pontos turísticos")
        except Exception as e:
            print(f"[pontos turísticos] {e}")
        try:
            tours, problems = experiences.search([name, explore._english_name(row.get("qid"))])
            db.upsert("destinations", {"code": code, "experiences": tours, "experiences_at": now()}, "code")
            print(f"{len(tours)} passeios {problems}")
        except Exception as e:
            print(f"[passeios] {e}")
        db.update("guide_requests", {"id": f"eq.{req_id}"}, {"status": "done", "ready_at": now(), "name": name})
        settings = (db.select("settings", {"id": "eq.1"}) or [{}])[0]
        url = notify.app_url(f"#/guide/{code}")
        text = f"🧭 *Seu guia de {name} está pronto!*\nFotos, clima, pontos turísticos, passeios com preço e quanto custa a viagem."
        if url:
            text += f"\n📖 Abrir: {url}"
        used = notify.broadcast(db, settings, f"🧭 Guia de {name} pronto", text, url)
        print(f"guia de {name} pronto; aviso por {', '.join(used) or 'nenhum canal'}")
    except Exception as e:
        traceback.print_exc()
        db.update("guide_requests", {"id": f"eq.{req_id}"}, {"status": "error", "error": str(e)[:300]})


if __name__ == "__main__":
    rid = sys.argv[1] if len(sys.argv) > 1 else ""
    if not re.fullmatch(r"[0-9a-f-]{36}", rid):
        sys.exit("uso: python guide_job.py <uuid do pedido>")
    run(DB(), rid)
