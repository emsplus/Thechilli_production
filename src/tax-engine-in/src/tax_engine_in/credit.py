"""Credit notes / refunds: proportional reversal of an invoice, exact in aggregate.

Each invoice component c (per line: taxable, cgst, sgst, igst; plus the round-off) is reversed through a
CUMULATIVE share: reversed_so_far(f) = round_half_up(c * f), where f is the cumulative fraction of the line
already credited. A note's amount = R(f_after) - R(f_before). Hence notes telescope: once every line reaches
f = 1 the notes add up to the invoice EXACTLY, and no note can carry a negative tax.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from fractions import Fraction
from typing import Mapping, Sequence

from .errors import TaxError
from .models import SCHEMA, Invoice, LineOut, need_int
from .rounding import round_half_up
from .summary import breakup_by_rate, hsn_summary
from .validation import iso_date

ONE = Fraction(1)


@dataclass
class CreditNote:
    lines: list[LineOut]                  # reversed amounts per original line (same order/index)
    delta: list[Fraction]                 # incremental fraction of each ORIGINAL line credited by this note
    round_off_delta: Fraction
    taxable_total: int
    cgst: int
    sgst: int
    igst: int
    round_off: int
    total: int                            # amount to refund (signed round-off included)
    breakup: list = field(default_factory=list)
    hsn_summary: list = field(default_factory=list)
    number: str | None = None                       # this credit note's number (numbering.document_number)
    date: str | None = None                         # ISO YYYY-MM-DD
    original_invoice_number: str | None = None      # reference to the invoice being credited
    original_invoice_date: str | None = None

    @property
    def tax_total(self) -> int:
        return self.cgst + self.sgst + self.igst

    def to_dict(self) -> dict:
        """Lossless persistence form. Fractions are 'numerator/denominator' strings, money is integer paise.
        Reload with from_dict and pass as `previous` to replay later credit notes against the same invoice."""
        return {
            "schema": SCHEMA, "lines": [l.to_dict() for l in self.lines],
            "delta": [f"{f.numerator}/{f.denominator}" for f in self.delta],
            "round_off_delta": f"{self.round_off_delta.numerator}/{self.round_off_delta.denominator}",
            "taxable_total": self.taxable_total, "cgst": self.cgst, "sgst": self.sgst, "igst": self.igst,
            "round_off": self.round_off, "total": self.total, "number": self.number, "date": self.date,
            "original_invoice_number": self.original_invoice_number,
            "original_invoice_date": self.original_invoice_date,
        }

    @classmethod
    def from_dict(cls, d: dict) -> CreditNote:
        if not isinstance(d, dict) or d.get("schema") != SCHEMA:
            raise TaxError("Unsupported or missing credit note schema")

        def frac(v: object) -> Fraction:
            if not isinstance(v, str):
                raise TaxError("Fractions must be strings like '1/3'")
            try:
                return Fraction(v)
            except (ValueError, ZeroDivisionError):
                raise TaxError(f"Invalid fraction '{v}'") from None

        try:
            lines = [LineOut.from_dict(x, fractional_quantity=True) for x in d["lines"]]
            delta = [frac(x) for x in d["delta"]]
            note = cls(lines=lines, delta=delta, round_off_delta=frac(d["round_off_delta"]),
                       taxable_total=need_int(d, "taxable_total"), cgst=need_int(d, "cgst"),
                       sgst=need_int(d, "sgst"), igst=need_int(d, "igst"), round_off=need_int(d, "round_off"),
                       total=need_int(d, "total"), number=d.get("number"), date=d.get("date"),
                       original_invoice_number=d.get("original_invoice_number"),
                       original_invoice_date=d.get("original_invoice_date"))
        except KeyError as e:
            raise TaxError(f"Missing credit note field {e}") from None
        if len(delta) != len(lines) or any(x < 0 or x > 1 for x in [*delta, note.round_off_delta]):
            raise TaxError("Credit note fractions are inconsistent")
        if (note.taxable_total, note.cgst, note.sgst, note.igst) != tuple(
                sum(getattr(l, k) for l in lines) for k in ("taxable", "cgst", "sgst", "igst")):
            raise TaxError("Credit note totals do not match its lines")
        if note.total != sum(l.gross for l in lines) + note.round_off:
            raise TaxError("Credit note total does not match its lines")
        note.breakup = breakup_by_rate(lines)
        note.hsn_summary = hsn_summary(lines)
        return note


def _cum(n: int, previous: Sequence[CreditNote]) -> tuple[list[Fraction], Fraction]:
    cum, ro = [Fraction(0)] * n, Fraction(0)
    for p in previous:
        if len(p.delta) != n:
            raise TaxError("Previous credit note does not belong to this invoice")
        cum = [c + d for c, d in zip(cum, p.delta)]
        ro += p.round_off_delta
    return cum, ro


def _build(inv: Invoice, delta: list[Fraction], ro_delta: Fraction, previous: Sequence[CreditNote],
           number: str | None = None, on: date | str | None = None) -> CreditNote:
    for p in previous:
        if (p.original_invoice_number and inv.invoice_number
                and p.original_invoice_number != inv.invoice_number):
            raise TaxError("Previous credit note refers to a different invoice")
    before, ro_before = _cum(len(inv.lines), previous)
    after = [b + d for b, d in zip(before, delta)]
    ro_after = ro_before + ro_delta
    if any(a > ONE or d < 0 for a, d in zip(after, delta)) or ro_after > ONE or ro_delta < 0:
        raise TaxError("Credit exceeds what remains on the invoice", 409)

    def rev(c: int, b: Fraction, a: Fraction) -> int:
        return round_half_up(c * a) - round_half_up(c * b)

    out: list[LineOut] = []
    for l, b, a, d in zip(inv.lines, before, after, delta):
        out.append(LineOut(kind=l.kind, description=l.description, hsn=l.hsn, quantity=l.quantity * d,
                           unit_price=l.unit_price, tax_code=l.tax_code, rate_percent=l.rate_percent,
                           line_amount=rev(l.line_amount, b, a), discount=rev(l.discount, b, a),
                           taxable=rev(l.taxable, b, a), cgst=rev(l.cgst, b, a), sgst=rev(l.sgst, b, a),
                           igst=rev(l.igst, b, a), item_id=l.item_id))
    for o in out:  # quantity as Decimal for fractional credits
        o.quantity = Decimal(o.quantity.numerator) / Decimal(o.quantity.denominator)
    ro = rev(inv.round_off, ro_before, ro_after)
    note = CreditNote(lines=out, delta=delta, round_off_delta=ro_delta,
                      taxable_total=sum(l.taxable for l in out), cgst=sum(l.cgst for l in out),
                      sgst=sum(l.sgst for l in out), igst=sum(l.igst for l in out), round_off=ro,
                      total=sum(l.gross for l in out) + ro, number=number, date=iso_date(on, "credit note date"),
                      original_invoice_number=inv.invoice_number, original_invoice_date=inv.invoice_date)
    note.breakup = breakup_by_rate(out)
    note.hsn_summary = hsn_summary(out)
    return note


def credit_note_items(inv: Invoice, item_qty: Mapping[int, int], previous: Sequence[CreditNote] = (),
                      charges: str = "proportional", credit_note_number: str | None = None,
                      credit_note_date: date | str | None = None) -> CreditNote:
    """Return `item_qty[line_index]` units of item lines. Charges (service/packaging/delivery) and the round-off
    follow the credited share F of the discounted item value ("proportional"), or are left alone ("none")."""
    if charges not in ("proportional", "none"):
        raise TaxError("charges must be 'proportional' or 'none'")
    n = len(inv.lines)
    delta = [Fraction(0)] * n
    for i, q in item_qty.items():
        if not 0 <= i < n or inv.lines[i].kind != "item":
            raise TaxError(f"Line index {i} is not an item line")
        if not isinstance(q, int) or q < 1:
            raise TaxError("Credit quantity must be a positive integer")
        delta[i] = Fraction(q, inv.lines[i].quantity)
    items = [i for i, l in enumerate(inv.lines) if l.kind == "item"]
    weight = {i: inv.lines[i].gross for i in items}
    wsum = sum(weight.values())
    if wsum > 0:
        f = sum(delta[i] * weight[i] for i in items) / wsum
    else:
        f = sum(delta[i] * inv.lines[i].quantity for i in items) / sum(inv.lines[i].quantity for i in items)
    if charges == "proportional":
        for i, l in enumerate(inv.lines):
            if l.kind != "item":
                delta[i] = f
        ro = f
    else:
        ro = Fraction(0)
    return _build(inv, delta, ro, previous, credit_note_number, credit_note_date)


def credit_note_fraction(inv: Invoice, fraction: Fraction | Decimal | str, previous: Sequence[CreditNote] = (),
                         credit_note_number: str | None = None,
                         credit_note_date: date | str | None = None) -> CreditNote:
    """Reverse the same fraction (0 < f <= 1) of EVERY component, including charges and round-off."""
    f = Fraction(Decimal(fraction)) if not isinstance(fraction, Fraction) else fraction
    if not 0 < f <= 1:
        raise TaxError("Credit fraction must be in (0, 1]")
    return _build(inv, [f] * len(inv.lines), f, previous, credit_note_number, credit_note_date)


def credit_note_amount(inv: Invoice, amount: int, previous: Sequence[CreditNote] = (),
                       credit_note_number: str | None = None,
                       credit_note_date: date | str | None = None) -> CreditNote:
    """Amount-based refund: fraction = amount / invoice.total. The note total can differ from `amount` by a few
    paise of rounding (the tax split is authoritative); the cumulative total never exceeds the invoice."""
    if amount <= 0 or inv.total <= 0:
        raise TaxError("Refund amount must be positive")
    if amount > inv.total:
        raise TaxError("Refund exceeds the invoice total", 409)
    return credit_note_fraction(inv, Fraction(amount, inv.total), previous, credit_note_number, credit_note_date)
