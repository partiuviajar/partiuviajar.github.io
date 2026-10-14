from dataclasses import dataclass
from datetime import date


@dataclass
class Quote:
    source: str            # 'google' | 'aviasales'
    depart_date: date
    return_date: date | None
    price: float           # total em BRL para todos os passageiros
    airline: str | None = None
    stops: int | None = None
    duration_min: int | None = None
    link: str | None = None


class SourceError(Exception):
    """Falha ao consultar uma fonte (bloqueio, resposta inválida, etc.)."""
