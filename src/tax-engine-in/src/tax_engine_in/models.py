from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .errors import TaxError
from .rounding import from_minor
from .summary import breakup_by_rate, hsn_summary

SCHEMA = 1


def need_int(d: dict, key: str) -> int:
    v = d.get(key)
    if isinstance(v, bool) or not isinstance(v, int):
        raise TaxError(f"'{key}' must be an integer")
    return v


def need_dec(d: dict, key: str) -> Decimal:
    v = d.get(key)
    try:
        out = Decimal(v) if isinstance(v, str) else None
    except ArithmeticError:
        out = None
    if out is None or not out.is_finite():
        raise TaxError(f"'{key}' must be a decimal string")
    return out


@dataclass(frozen=True)
class LineIn:
    description: str
    quantity: int
    unit_price: int                 # paise (tax-inclusive or exclusive per the invoice's prices_include_tax)
    supply_type: str = "restaurant"  # "restaurant" (rate from treatment) | "goods" | "other" (tax_code required)
    tax_code: str | None = None
    hsn: str | None = None          # HSN (goods) or SAC (services)
    item_id: Any = None
    allow_no_tax: bool = False      # explicit opt-in required to use tax_code 'none' (zero tax) on a goods/other line
    discount: int = 0               # line-level discount (item / category offer), integer paise in the invoice's price
                                    # mode, 0 <= discount <= unit_price * quantity; applied to THIS line only, before tax


@dataclass(frozen=True)
class DiscountIn:
    type: str                       # "percent" (Decimal 0-100) | "amount" (integer paise)
    value: Decimal | str | int      # never float
    reason: str = ""


@dataclass(frozen=True)
class ChargeIn:
    kind: str                       # "packaging" | "delivery"
    amount: int                     # paise, in the invoice's price mode
    tax_code: str | None = None     # None => follows the principal supply (highest line rate)
    hsn: str | None = None
    description: str | None = None
    allow_no_tax: bool = False      # explicit opt-in required for tax_code 'none'


@dataclass
class LineOut:
    """Line snapshot: everything needed to reprint / credit the line later without the live config."""
    kind: str                       # item | service_charge | packaging | delivery
    description: str
    hsn: str | None
    quantity: int
    unit_price: int
    tax_code: str
    rate_percent: Decimal
    line_amount: int                # shown amount BEFORE discount (price mode)
    discount: int                   # this line's own discount + its share of the bill discount
    taxable: int
    cgst: int
    sgst: int
    igst: int
    item_id: Any = None

    @property
    def tax(self) -> int:
        return self.cgst + self.sgst + self.igst

    @property
    def gross(self) -> int:
        return self.taxable + self.tax

    def to_dict(self) -> dict:
        """Lossless: integer paise, Decimals as strings."""
        return {"kind": self.kind, "description": self.description, "hsn": self.hsn, "quantity": str(self.quantity),
                "unit_price": self.unit_price, "tax_code": self.tax_code, "rate_percent": str(self.rate_percent),
                "line_amount": self.line_amount, "discount": self.discount, "taxable": self.taxable,
                "cgst": self.cgst, "sgst": self.sgst, "igst": self.igst, "item_id": self.item_id}

    @classmethod
    def from_dict(cls, d: dict, fractional_quantity: bool = False) -> LineOut:
        try:
            q = need_dec(d, "quantity")
            qty: int | Decimal = q if fractional_quantity else int(q)
            if not fractional_quantity and q != qty:
                raise TaxError("Invoice line quantity must be a whole number")
            return cls(kind=d["kind"], description=d["description"], hsn=d.get("hsn"), quantity=qty,
                       unit_price=need_int(d, "unit_price"), tax_code=d["tax_code"],
                       rate_percent=need_dec(d, "rate_percent"), line_amount=need_int(d, "line_amount"),
                       discount=need_int(d, "discount"), taxable=need_int(d, "taxable"), cgst=need_int(d, "cgst"),
                       sgst=need_int(d, "sgst"), igst=need_int(d, "igst"), item_id=d.get("item_id"))
        except KeyError as e:
            raise TaxError(f"Missing line field {e}") from None


@dataclass
class Invoice:
    lines: list[LineOut]
    document_type: str              # "tax_invoice" | "bill_of_supply"
    treatment: str
    itc_eligible: bool
    seller_state: str
    place_of_supply: str
    intra_state: bool
    prices_include_tax: bool
    discount_amount: int
    discount_reason: str | None
    service_charge_percent: Decimal
    taxable_total: int
    cgst: int
    sgst: int
    igst: int
    total_before_round_off: int
    round_off: int                  # signed, own line; never taxed
    total: int                      # payable
    breakup: list = field(default_factory=list)      # per-rate rows (summary.RateRow)
    hsn_summary: list = field(default_factory=list)  # per (hsn, rate) rows
    invoice_number: str | None = None               # see numbering.document_number
    invoice_date: str | None = None                 # ISO YYYY-MM-DD
    line_discount_amount: int = 0                   # part of discount_amount that came from per-line discounts

    @property
    def bill_discount_amount(self) -> int:
        """The bill-level part of discount_amount (spread proportionally over the item lines)."""
        return self.discount_amount - self.line_discount_amount

    @property
    def tax_total(self) -> int:
        return self.cgst + self.sgst + self.igst

    # pos-service naming aliases
    @property
    def subtotal(self) -> int:
        return self.taxable_total

    @property
    def tax_amount(self) -> int:
        return self.tax_total

    def as_dict(self) -> dict:
        """JSON-friendly view with rupee strings (same style as pos-service's tax_breakdown)."""
        m = lambda p: str(from_minor(p))
        return {
            "document_type": self.document_type, "treatment": self.treatment, "itc_eligible": self.itc_eligible,
            "seller_state": self.seller_state, "place_of_supply": self.place_of_supply,
            "prices_include_tax": self.prices_include_tax,
            "lines": [{"kind": l.kind, "description": l.description, "hsn": l.hsn, "quantity": l.quantity,
                       "unit_price": m(l.unit_price), "tax_code": l.tax_code, "rate_percent": str(l.rate_percent),
                       "line_amount": m(l.line_amount), "discount": m(l.discount), "taxable": m(l.taxable),
                       "cgst": m(l.cgst), "sgst": m(l.sgst), "igst": m(l.igst), "gross": m(l.gross)}
                      for l in self.lines],
            "discount_amount": m(self.discount_amount), "line_discount_amount": m(self.line_discount_amount),
            "subtotal": m(self.taxable_total),
            "cgst": m(self.cgst), "sgst": m(self.sgst), "igst": m(self.igst), "tax_amount": m(self.tax_total),
            "round_off": m(self.round_off), "total": m(self.total),
            "tax_breakdown": [r.as_dict() for r in self.breakup],
            "intra_state": self.intra_state,
            "hsn_summary": [r.as_dict() for r in self.hsn_summary],
            "invoice_number": self.invoice_number, "invoice_date": self.invoice_date,
        }

    def to_dict(self) -> dict:
        """Lossless persistence form (integer paise, Decimals as strings); inverse of from_dict.
        breakup / hsn_summary are derived and rebuilt from the lines on load."""
        return {
            "schema": SCHEMA, "lines": [l.to_dict() for l in self.lines], "document_type": self.document_type,
            "treatment": self.treatment, "itc_eligible": self.itc_eligible, "seller_state": self.seller_state,
            "place_of_supply": self.place_of_supply, "intra_state": self.intra_state,
            "prices_include_tax": self.prices_include_tax, "discount_amount": self.discount_amount,
            "line_discount_amount": self.line_discount_amount, "discount_reason": self.discount_reason, "service_charge_percent": str(self.service_charge_percent),
            "taxable_total": self.taxable_total, "cgst": self.cgst, "sgst": self.sgst, "igst": self.igst,
            "total_before_round_off": self.total_before_round_off, "round_off": self.round_off,
            "total": self.total, "invoice_number": self.invoice_number, "invoice_date": self.invoice_date,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Invoice:
        if not isinstance(d, dict) or d.get("schema") != SCHEMA:
            raise TaxError("Unsupported or missing invoice schema")
        try:
            lines = [LineOut.from_dict(x) for x in d["lines"]]
            inv = cls(lines=lines, document_type=d["document_type"], treatment=d["treatment"],
                      itc_eligible=bool(d["itc_eligible"]), seller_state=d["seller_state"],
                      place_of_supply=d["place_of_supply"], intra_state=bool(d["intra_state"]),
                      prices_include_tax=bool(d["prices_include_tax"]), discount_amount=need_int(d, "discount_amount"),
                      discount_reason=d.get("discount_reason"),
                      service_charge_percent=need_dec(d, "service_charge_percent"),
                      taxable_total=need_int(d, "taxable_total"), cgst=need_int(d, "cgst"), sgst=need_int(d, "sgst"),
                      igst=need_int(d, "igst"), total_before_round_off=need_int(d, "total_before_round_off"),
                      round_off=need_int(d, "round_off"), total=need_int(d, "total"),
                      invoice_number=d.get("invoice_number"), invoice_date=d.get("invoice_date"),
                      # absent in invoices stored before 0.2.0 (no per-line discounts existed then)
                      line_discount_amount=need_int(d, "line_discount_amount") if "line_discount_amount" in d else 0)
        except KeyError as e:
            raise TaxError(f"Missing invoice field {e}") from None
        if not 0 <= inv.line_discount_amount <= inv.discount_amount:
            raise TaxError("Invoice line discount does not fit its discount amount")
        if (inv.taxable_total, inv.cgst, inv.sgst, inv.igst) != tuple(
                sum(getattr(l, k) for l in lines) for k in ("taxable", "cgst", "sgst", "igst")):
            raise TaxError("Invoice totals do not match its lines")
        if (inv.total_before_round_off != sum(l.gross for l in lines)
                or inv.total != inv.total_before_round_off + inv.round_off):
            raise TaxError("Invoice grand total does not match its lines")
        inv.breakup = breakup_by_rate(lines)
        inv.hsn_summary = hsn_summary(lines)
        return inv
