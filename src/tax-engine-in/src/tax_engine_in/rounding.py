"""Exact integer/Fraction arithmetic. All money is integer paise (minor units)."""
from __future__ import annotations

from decimal import Decimal
from fractions import Fraction
from math import floor
from typing import Sequence

from .errors import TaxError

PAISE_PER_RUPEE = 100


def round_half_up(x: Fraction | int) -> int:
    """The engine's ONE rounding rule: round half up to an integer (0.5 -> 1), exact (no floats)."""
    return floor(Fraction(x) + Fraction(1, 2))


def allocate(total: int, weights: Sequence[int]) -> list[int]:
    """Split `total` paise proportionally to non-negative integer `weights`; shares add up EXACTLY.
    Largest-remainder method, ties broken by lowest index (deterministic)."""
    n = len(weights)
    if total < 0 or any(w < 0 for w in weights):
        raise TaxError("allocate() needs non-negative total and weights")
    if n == 0 or total == 0:
        return [0] * n
    wsum = sum(weights)
    if wsum == 0:
        raise TaxError("Cannot allocate a non-zero amount over zero-weight lines")
    shares = [total * w // wsum for w in weights]
    rems = [total * w % wsum for w in weights]
    left = total - sum(shares)
    for i in sorted(range(n), key=lambda i: (-rems[i], i))[:left]:
        shares[i] += 1
    return shares


def to_minor(rupees: Decimal | str | int) -> int:
    """Decimal rupees -> integer paise (must be exact to 2 dp; no silent rounding)."""
    d = Decimal(rupees) * 100
    if d != d.to_integral_value():
        raise TaxError(f"{rupees} has more than 2 decimal places")
    return int(d)


def from_minor(paise: int) -> Decimal:
    return (Decimal(paise) / 100).quantize(Decimal("0.01"))


def to_fraction(x: Decimal | int | str | Fraction) -> Fraction:
    return Fraction(Decimal(x)) if not isinstance(x, Fraction) else x
