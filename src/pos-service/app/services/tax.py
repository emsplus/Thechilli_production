"""Generic tax engine (tax_mode 'off'; the GST engine, tax_mode 'gst_engine', lives in services/gst.py). PURE functions
(no DB, no I/O): everything is Decimal and unit-testable. Rate rows come from tax_rates (India placeholders:
services/localisation.py RATES).

Calculation (per tax-code group; lines are grouped by tax code):
  * prices include tax : tax = round_half_up(gross_group * rate / (100 + rate), 2); net = gross - tax
  * prices exclude tax : net = group sum; tax = round_half_up(net * rate / 100, 2); gross = net + tax
Tax is rounded ONCE per group (never per line), so a bill with one standard group and exclusive prices is numerically
identical to "round the tax once on the invoice total". Per-line net/tax/gross are informational: the group's tax is
spread over its lines with the largest-remainder method so lines add up exactly. Totals: subtotal = sum(net) ("total
excl. tax"), tax_amount = sum(tax), total = sum(gross) (what the customer pays). The per-line / per-group tax is stored
under the key `vat` (field name kept for API compatibility).

Order of operations: line amounts -> discount (spread proportionally over item lines, BEFORE tax) -> service charge
(on the post-discount item amounts; its own standard-rated line) -> group by tax code -> tax.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal
from typing import Any, Mapping, Sequence

from app.services.localisation import EAT_IN_ORDER_TYPES

PAISA = Decimal("0.01")
ZERO = Decimal("0.00")
HUNDRED = Decimal(100)
CODE_ORDER = {"standard": 0, "zero": 1, "none": 2}


class TaxError(ValueError):
    """Invalid input to the engine (bad discount, missing rate...). The API maps it to HTTP 409/422."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def money(x: Decimal) -> Decimal:
    return x.quantize(PAISA, rounding=ROUND_HALF_UP)


def is_eat_in(order_type: Any) -> bool:
    return getattr(order_type, "value", order_type) in EAT_IN_ORDER_TYPES


def line_tax_code(registered: bool = True) -> str:
    """Tax code of one order line: 'standard', or 'none' when the seller is not GST registered (`vat_registered`)."""
    return "standard" if registered else "none"


def service_charge_applies(order_type: Any) -> bool:
    return is_eat_in(order_type)


# ------------------------------------------------------------------ data classes
@dataclass(frozen=True)
class LineIn:
    description: str
    quantity: int
    unit_price: Decimal
    tax_code: str
    item_id: Any = None


@dataclass(frozen=True)
class DiscountIn:
    type: str            # "percent" | "amount"
    value: Decimal
    reason: str = ""


@dataclass
class LineOut:
    description: str
    quantity: int
    unit_price: Decimal
    tax_code: str
    rate_percent: Decimal
    line_total: Decimal  # amount shown on the receipt line, BEFORE discount (gross if prices include tax, else net)
    discount: Decimal    # this line's share of the bill discount
    gross: Decimal       # after discount
    net: Decimal
    vat: Decimal
    item_id: Any = None


@dataclass
class Invoice:
    lines: list[LineOut]
    prices_include_tax: bool
    discount_amount: Decimal
    discount_reason: str | None
    service_charge_percent: Decimal
    service_charge_amount: Decimal       # in the price mode (gross if inclusive, else net)
    service_charge: LineOut | None
    subtotal: Decimal                    # total excl. tax
    tax_amount: Decimal
    total: Decimal                       # payable
    tax_breakdown: list[dict] = field(default_factory=list)  # [{code, rate_percent, net, vat, gross}] decimals as str


# ------------------------------------------------------------------ helpers
def allocate(total: Decimal, weights: Sequence[Decimal]) -> list[Decimal]:
    """Splits `total` (paise) proportionally to `weights`; shares add up EXACTLY (largest remainder, ties by index)."""
    n = len(weights)
    paise = int((total * 100).to_integral_value(ROUND_HALF_UP))
    wsum = sum(weights, Decimal(0))
    if n == 0 or paise == 0 or wsum == 0:
        return [ZERO] * n
    raw = [Decimal(paise) * w / wsum for w in weights]
    floors = [int(r.to_integral_value(ROUND_FLOOR)) for r in raw]
    left = paise - sum(floors)
    order = sorted(range(n), key=lambda i: (-(raw[i] - floors[i]), i))
    for i in order[:left]:
        floors[i] += 1
    return [Decimal(f) / 100 for f in floors]


def _rate(code: str, rates: Mapping[str, Decimal]) -> Decimal:
    if code == "none":
        return Decimal(0)
    if code not in rates:
        raise TaxError(f"No tax rate configured for code '{code}'", 409)
    return Decimal(rates[code])


DEFAULT_DISCOUNT_REASON = "Discount"  # stored when staff give no reason; receipts print just "Discount" for it


def validate_discount(d: DiscountIn) -> DiscountIn:
    if d.type not in ("percent", "amount"):
        raise TaxError("Discount type must be 'percent' or 'amount'")
    if d.value <= 0:
        raise TaxError("Discount value must be positive")
    if d.type == "percent" and d.value > 100:
        raise TaxError("Discount cannot exceed 100%")
    reason = " ".join((d.reason or "").split())
    if not reason:  # the reason is optional: the bill then just says "Discount" (the engine wants a 3-200 character label)
        reason = DEFAULT_DISCOUNT_REASON
    elif not 3 <= len(reason) <= 200:
        raise TaxError("Discount reason must be 3-200 characters (or leave it empty)")
    return DiscountIn(d.type, d.value, reason)


def discount_percent_of(d: DiscountIn, base: Decimal) -> Decimal:
    """The discount expressed as a percentage of the item total (used for the cashier limit)."""
    if d.type == "percent":
        return d.value
    return (d.value / base * 100) if base > 0 else Decimal(0)


def item_total(lines: Sequence[LineIn]) -> Decimal:
    return sum((money(l.unit_price * l.quantity) for l in lines), ZERO)


# ------------------------------------------------------------------ the engine
def compute_invoice(lines: Sequence[LineIn], rates: Mapping[str, Decimal], prices_include_tax: bool,
                    service_charge_percent: Decimal = ZERO, discount: DiscountIn | None = None,
                    service_charge_code: str = "standard", line_discounts: Sequence[Decimal] | None = None,
                    discount_reason: str | None = None) -> Invoice:
    """`line_discounts` (instead of `discount`): the discount of each line, already decided by the caller (automatic offers
    that target some items, docs/MODIFIERS_OFFERS.md); `discount_reason` is then the bill's discount reason."""
    amounts = [money(l.unit_price * l.quantity) for l in lines]
    base = sum(amounts, ZERO)

    # 1. discount, spread proportionally over the item lines before the tax is derived
    disc_total, reason, shares = ZERO, None, [ZERO] * len(lines)
    if line_discounts is not None:
        if discount is not None:
            raise TaxError("Give either a discount or line discounts, not both")
        if len(line_discounts) != len(lines):
            raise TaxError("One line discount per line is required")
        shares = [money(Decimal(d)) for d in line_discounts]
        if any(d < 0 or d > a for d, a in zip(shares, amounts)):
            raise TaxError("A line discount cannot be negative or exceed its line")
        disc_total = sum(shares, ZERO)
        reason = (discount_reason or "").strip() or None if disc_total > 0 else None
    elif discount is not None:
        discount = validate_discount(discount)
        disc_total = money(base * discount.value / 100) if discount.type == "percent" else money(discount.value)
        if disc_total > base:
            raise TaxError("Discount cannot exceed the bill total")
        shares = allocate(disc_total, amounts)
        reason = discount.reason
    after = [a - s for a, s in zip(amounts, shares)]

    # 2. service charge on the post-discount item amounts (eat-in only: the caller passes 0 otherwise)
    sc_pct = Decimal(service_charge_percent or 0)
    sc_amount = money(sum(after, ZERO) * sc_pct / 100) if sc_pct > 0 else ZERO

    # 3. group by tax code (the service charge joins `service_charge_code`)
    entries: list[tuple[str, Decimal]] = [(l.tax_code, a) for l, a in zip(lines, after)]
    sc_index = None
    if sc_amount > 0:
        sc_index = len(entries)
        entries.append((service_charge_code, sc_amount))
    groups: dict[str, list[int]] = {}
    for i, (code, _) in enumerate(entries):
        groups.setdefault(code, []).append(i)

    net = [ZERO] * len(entries)
    vat = [ZERO] * len(entries)
    breakdown: list[dict] = []
    for code in sorted(groups, key=lambda c: (CODE_ORDER.get(c, 9), c)):
        idx = groups[code]
        rate = _rate(code, rates)
        amts = [entries[i][1] for i in idx]
        total = sum(amts, ZERO)
        if prices_include_tax:
            g_vat = money(total * rate / (HUNDRED + rate))
            g_net, g_gross = total - g_vat, total
        else:
            g_vat = money(total * rate / HUNDRED)
            g_net, g_gross = total, total + g_vat
        vats = allocate(g_vat, amts)
        for i, a, v in zip(idx, amts, vats):
            vat[i] = v
            net[i] = a - v if prices_include_tax else a
        breakdown.append({"code": code, "rate_percent": str(rate.quantize(PAISA)), "net": str(g_net),
                          "vat": str(g_vat), "gross": str(g_gross)})

    def out_line(i: int, l_desc: str, qty: int, unit: Decimal, code: str, shown: Decimal, disc: Decimal, item_id) -> LineOut:
        return LineOut(description=l_desc, quantity=qty, unit_price=unit, tax_code=code,
                       rate_percent=_rate(code, rates).quantize(PAISA), line_total=shown, discount=disc,
                       gross=net[i] + vat[i], net=net[i], vat=vat[i], item_id=item_id)

    out = [out_line(i, l.description, l.quantity, l.unit_price, l.tax_code, amounts[i], shares[i], l.item_id)
           for i, l in enumerate(lines)]
    sc_line = (out_line(sc_index, "Service charge", 1, sc_amount, service_charge_code, sc_amount, ZERO, None)
               if sc_index is not None else None)
    sub = sum((Decimal(b["net"]) for b in breakdown), ZERO)
    tax = sum((Decimal(b["vat"]) for b in breakdown), ZERO)
    tot = sum((Decimal(b["gross"]) for b in breakdown), ZERO)
    return Invoice(lines=out, prices_include_tax=prices_include_tax, discount_amount=disc_total,
                   discount_reason=reason, service_charge_percent=sc_pct if sc_amount > 0 else ZERO,
                   service_charge_amount=sc_amount, service_charge=sc_line, subtotal=sub, tax_amount=tax,
                   total=tot, tax_breakdown=breakdown)


def refund_tax(amount: Decimal, bill_total: Decimal, bill_tax: Decimal, single_rate: Decimal | None) -> Decimal:
    """Tax portion of a refund (credit note).
    * one rate on the bill (or a legacy bill): tax = round(amount * rate / (100 + rate), 2)
    * several rates (e.g. standard + zero): pro-rata, tax = round(amount * bill.tax_amount / bill.total, 2)
    The pro-rata rule is an approximation: a partial refund cannot know which lines it refers to."""
    if single_rate is not None:
        return money(amount * single_rate / (HUNDRED + single_rate))
    if bill_total <= 0:
        return ZERO
    return money(amount * bill_tax / bill_total)


def single_rate_of(breakdown: Sequence[Mapping] | None, legacy_rate: Decimal) -> Decimal | None:
    """The one tax rate of a bill, or None when it has several different rates (use pro-rata)."""
    if not breakdown:
        return Decimal(legacy_rate)
    rates = {Decimal(str(b["rate_percent"])) for b in breakdown if Decimal(str(b["gross"])) != 0}
    if len(rates) <= 1:
        return next(iter(rates), Decimal(0))
    return None
