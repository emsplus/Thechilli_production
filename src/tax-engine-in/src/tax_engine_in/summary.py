"""GSTR-style summaries. Works on anything with rate_percent/taxable/cgst/sgst/igst (LineOut, CreditLine)."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable

from .rounding import from_minor


@dataclass
class RateRow:
    rate_percent: Decimal
    taxable: int = 0
    cgst: int = 0
    sgst: int = 0
    igst: int = 0

    @property
    def tax(self) -> int:
        return self.cgst + self.sgst + self.igst

    @property
    def gross(self) -> int:
        return self.taxable + self.tax

    def as_dict(self) -> dict:
        m = lambda p: str(from_minor(p))
        return {"rate_percent": str(self.rate_percent), "taxable": m(self.taxable), "cgst": m(self.cgst),
                "sgst": m(self.sgst), "igst": m(self.igst), "tax": m(self.tax), "gross": m(self.gross)}


@dataclass
class HsnRow(RateRow):
    hsn: str | None = None
    quantity: Decimal = Decimal(0)

    def as_dict(self) -> dict:
        return {"hsn": self.hsn, **super().as_dict(), "quantity": str(self.quantity)}


def _norm(r: Decimal) -> Decimal:
    return r.normalize() if r != 0 else Decimal(0)


def breakup_by_rate(lines: Iterable) -> list[RateRow]:
    rows: dict[Decimal, RateRow] = {}
    for l in lines:
        key = _norm(l.rate_percent)
        r = rows.setdefault(key, RateRow(key))
        r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst
    return [rows[k] for k in sorted(rows)]


def hsn_summary(lines: Iterable) -> list[HsnRow]:
    rows: dict[tuple, HsnRow] = {}
    for l in lines:
        key = (l.hsn or "", _norm(l.rate_percent))
        r = rows.setdefault(key, HsnRow(key[1], hsn=l.hsn))
        r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst
        if l.kind == "item":
            r.quantity += Decimal(l.quantity)
    return [rows[k] for k in sorted(rows, key=lambda k: (k[0], k[1]))]
