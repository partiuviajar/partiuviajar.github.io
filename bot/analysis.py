"""Regras de preço normal e de alerta."""

from dataclasses import dataclass, field
from statistics import median

MIN_HISTORY = 4          # verificações necessárias para confiar no histórico de uma data
MIN_CROSS_SECTION = 7    # dias com preço no mês para usar a mediana do mês como referência
NEW_LOW_MARGIN = 0.02    # "menor preço já visto" precisa ser pelo menos 2% abaixo do anterior
REALERT_DROP = 0.03      # só avisa de novo a mesma data se cair mais 3%


def normal_price(history: list[float], month_prices: list[float] | None) -> tuple[float | None, str]:
    """Preço normal de uma data: mediana do histórico dela ou, no começo, mediana do mês inteiro."""
    if len(history) >= MIN_HISTORY:
        return median(history), "history"
    if month_prices and len(month_prices) >= MIN_CROSS_SECTION:
        return median(month_prices), "month"
    return None, "learning"


@dataclass
class Verdict:
    alert: bool
    reasons: list[str] = field(default_factory=list)
    pct_below: float | None = None


def evaluate(price: float, normal: float | None, history: list[float],
             threshold_pct: int, target_price: float | None) -> Verdict:
    reasons = []
    pct_below = None
    if normal:
        pct_below = round((normal - price) / normal * 100, 1)
        if pct_below >= threshold_pct:
            reasons.append(f"{pct_below:.0f}% abaixo do normal")
    if target_price and price <= target_price:
        reasons.append("abaixo do seu preço-alvo")
    if len(history) >= MIN_HISTORY and price <= min(history) * (1 - NEW_LOW_MARGIN):
        reasons.append("menor preço já visto")
    if normal and pct_below is not None and pct_below >= 60:
        reasons.append("confira rápido: pode ser erro de tarifa")
    real = [r for r in reasons if not r.startswith("confira")]
    return Verdict(alert=bool(real), reasons=reasons, pct_below=pct_below)


def is_repeat(price: float, last_alerted_price: float | None) -> bool:
    """Evita spam: mesma data já avisada e o preço não caiu o suficiente desde então."""
    return last_alerted_price is not None and price > last_alerted_price * (1 - REALERT_DROP)
