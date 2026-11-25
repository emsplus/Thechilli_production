"""Pure GST engine (integer paise, no I/O). See docs/RULES.md for every rule (all UNVERIFIED).

Order of operations (mirrors pos-service tax.py):
  line amounts -> per-line discounts (item/category offers, each on its own line) -> bill discount (spread over ITEM
  lines proportionally to their post-line-discount amounts, before tax) -> service charge (on post-discount items)
  -> packaging / delivery charges -> group by tax code -> tax computed ONCE per group with round-half-up
  -> group tax spread over its lines (largest remainder) -> round-off to the rupee as a separate line.
Intra-state: CGST == SGST always (each is half the rate). Inter-state: IGST.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from fractions import Fraction
from typing import Sequence

from .config import NO_TAX, TaxConfig
from .errors import TaxError
from .models import ChargeIn, DiscountIn, Invoice, LineIn, LineOut
from .rounding import PAISE_PER_RUPEE, allocate, round_half_up, to_fraction
from .summary import breakup_by_rate, hsn_summary
from .validation import iso_date, normalise_state_code, strict_decimal, validate_hsn_sac

SUPPLY_TYPES = ("restaurant", "goods", "other")


def validate_discount(d: DiscountIn) -> DiscountIn:
    if d.type not in ("percent", "amount"):
        raise TaxError("Discount type must be 'percent' or 'amount'")
    value = strict_decimal(d.value, "Discount value")
    if value <= 0:
        raise TaxError("Discount value must be positive")
    if d.type == "percent" and value > 100:
        raise TaxError("Discount cannot exceed 100%")
    if d.type == "amount" and value != value.to_integral_value():
        raise TaxError("Amount discount must be whole paise")
    reason = (d.reason or "").strip()
    if not 3 <= len(reason) <= 200:
        raise TaxError("Discount reason must be 3-200 characters")
    return DiscountIn(d.type, value if d.type == "percent" else int(value), reason)


def item_total(lines: Sequence[LineIn]) -> int:
    return sum(l.unit_price * l.quantity for l in lines)


def discount_percent_of(d: DiscountIn, base: int) -> Decimal:
    if d.type == "percent":
        return Decimal(d.value)
    return Decimal(d.value) * 100 / Decimal(base) if base > 0 else Decimal(0)


def _resolve_code(cfg: TaxConfig, l: LineIn) -> str:
    t = cfg.active
    if not t.collects_tax:
        return NO_TAX
    if l.supply_type not in SUPPLY_TYPES:
        raise TaxError(f"Unknown supply_type '{l.supply_type}'")
    if l.supply_type == "restaurant":
        if t.restaurant_code is None:
            raise TaxError(f"Treatment '{t.name}' has no restaurant rate; give the line goods/other + tax_code", 409)
        return t.restaurant_code
    if not l.tax_code:
        raise TaxError(f"Line '{l.description}': tax_code is required for supply_type '{l.supply_type}'")
    if l.tax_code == NO_TAX and not l.allow_no_tax:
        raise TaxError(f"Line '{l.description}': tax_code 'none' needs allow_no_tax=True (explicit opt-in)")
    cfg.rate(l.tax_code)  # validates
    return l.tax_code


def _cap(shares: list[int], caps: list[int]) -> list[int]:
    """Move units off any share that exceeds its cap (keeps taxable >= 0 on tiny lines). Sum is preserved."""
    n = len(shares)
    for i in range(n):
        while shares[i] > caps[i]:
            room = [(caps[j] - shares[j], -j) for j in range(n) if j != i]
            if not room or max(room)[0] <= 0:
                break
            j = -max(room)[1]
            shares[i] -= 1
            shares[j] += 1
    return shares


def _group_tax(total: int, rate: Fraction, inclusive: bool, intra: bool) -> tuple[int, int]:
    """-> (half, igst). intra: cgst=sgst=half. Rounded once per group, half-up."""
    if rate == 0 or total == 0:
        return 0, 0
    den = (100 + rate) if inclusive else Fraction(100)
    if intra:
        return round_half_up(Fraction(total) * rate / (2 * den)), 0
    return 0, round_half_up(Fraction(total) * rate / den)


@dataclass
class _Entry:
    kind: str
    description: str
    hsn: str | None
    quantity: int
    unit_price: int
    code: str
    shown: int
    discount: int
    amount: int
    item_id: object = None


def compute_invoice(lines: Sequence[LineIn], config: TaxConfig, prices_include_tax: bool,
                    service_charge_percent: Decimal | int | str = 0, discount: DiscountIn | None = None,
                    charges: Sequence[ChargeIn] = (), place_of_supply: str | None = None,
                    round_off: bool = True, service_charge_code: str | None = None,
                    invoice_number: str | None = None, invoice_date: date | str | None = None) -> Invoice:
    if not lines:
        raise TaxError("An invoice needs at least one line")
    for l in lines:
        if isinstance(l.quantity, bool) or not isinstance(l.quantity, int) or l.quantity < 1:
            raise TaxError(f"Line '{l.description}': quantity must be a positive integer")
        if isinstance(l.unit_price, bool) or not isinstance(l.unit_price, int) or l.unit_price < 0:
            raise TaxError(f"Line '{l.description}': unit_price must be non-negative integer paise")
        if isinstance(l.discount, bool) or not isinstance(l.discount, int) or l.discount < 0:
            raise TaxError(f"Line '{l.description}': discount must be non-negative integer paise")
        if l.discount > l.unit_price * l.quantity:
            raise TaxError(f"Line '{l.description}': discount cannot exceed the line amount")
        if l.hsn is not None:
            validate_hsn_sac(l.hsn)
    # None = caller did not say: place of supply is the seller's state (documented default). A blank string is an
    # error, never a silent fallback.
    pos = config.seller_state if place_of_supply is None else normalise_state_code(place_of_supply)
    intra = pos == config.seller_state

    codes = [_resolve_code(config, l) for l in lines]
    amounts = [l.unit_price * l.quantity for l in lines]
    line_disc = [l.discount for l in lines]
    # 1a. per-line discounts (exact paise from the caller, no rounding here)
    net = [a - d for a, d in zip(amounts, line_disc)]
    base = sum(net)

    # 1b. bill discount over the item lines' post-line-discount amounts, before tax
    bill_disc, reason, bill_shares = 0, None, [0] * len(lines)
    if discount is not None:
        discount = validate_discount(discount)
        bill_disc = (round_half_up(Fraction(base) * to_fraction(discount.value) / 100)
                     if discount.type == "percent" else int(discount.value))
        if bill_disc > base:
            raise TaxError("Discount cannot exceed the bill total")
        bill_shares = allocate(bill_disc, net)
        reason = discount.reason
    shares = [d + b for d, b in zip(line_disc, bill_shares)]
    disc_total = sum(shares)
    after = [a - s for a, s in zip(amounts, shares)]

    def default_hsn(l: LineIn) -> str | None:
        # restaurant service lines default to the configured SAC; goods/other (and packaging/delivery) stay None
        if l.hsn is not None:
            return l.hsn.strip()
        return config.restaurant_sac if l.supply_type == "restaurant" else None

    entries = [_Entry("item", l.description, default_hsn(l), l.quantity, l.unit_price, c, a, s, a - s, l.item_id)
               for l, c, a, s in zip(lines, codes, amounts, shares)]

    # principal supply rate for charges without an explicit code: highest item rate (mixed-supply rule)
    def principal_code() -> str:
        return max(codes, key=lambda c: (config.rate(c), c))

    def charge_code(explicit: str | None, allow_no_tax: bool = False) -> str:
        if not config.active.collects_tax:
            return NO_TAX
        if explicit is None:
            return principal_code()
        if explicit == NO_TAX and not allow_no_tax:
            raise TaxError("Charge tax_code 'none' needs allow_no_tax=True (explicit opt-in)")
        config.rate(explicit)
        return explicit

    # 2. service charge on post-discount item amounts
    sc_pct = strict_decimal(service_charge_percent or 0, "service_charge_percent")
    if sc_pct < 0 or sc_pct > 100:
        raise TaxError("Service charge percent must be within 0-100")
    sc_amount = round_half_up(Fraction(sum(after)) * to_fraction(sc_pct) / 100) if sc_pct > 0 else 0
    if sc_amount > 0:
        entries.append(_Entry("service_charge", "Service charge", config.restaurant_sac, 1, sc_amount,
                              charge_code(service_charge_code), sc_amount, 0, sc_amount))
    # 3. packaging / delivery
    for ch in charges:
        if ch.kind not in ("packaging", "delivery"):
            raise TaxError("Charge kind must be 'packaging' or 'delivery'")
        if isinstance(ch.amount, bool) or not isinstance(ch.amount, int) or ch.amount < 0:
            raise TaxError("Charge amount must be non-negative integer paise")
        if ch.hsn is not None:
            validate_hsn_sac(ch.hsn)
        if ch.amount > 0:
            entries.append(_Entry(ch.kind, ch.description or ch.kind.capitalize() + " charge",
                                  ch.hsn.strip() if ch.hsn else None, 1,
                                  ch.amount, charge_code(ch.tax_code, ch.allow_no_tax), ch.amount, 0, ch.amount))

    # 4. tax per code group
    n = len(entries)
    cgst, sgst, igst = [0] * n, [0] * n, [0] * n
    taxable = [0] * n
    groups: dict[str, list[int]] = {}
    for i, e in enumerate(entries):
        groups.setdefault(e.code, []).append(i)
    for code, idx in groups.items():
        rate = to_fraction(config.rate(code))
        amts = [entries[i].amount for i in idx]
        half, ig = _group_tax(sum(amts), rate, prices_include_tax, intra)
        halves = allocate(half, amts)
        igs = allocate(ig, amts)
        if prices_include_tax:
            halves = _cap(halves, [a // 2 for a in amts])
            igs = _cap(igs, list(amts))
        for k, i in enumerate(idx):
            cgst[i] = sgst[i] = halves[k]
            igst[i] = igs[k]
            tax = 2 * halves[k] + igs[k]
            taxable[i] = entries[i].amount - tax if prices_include_tax else entries[i].amount

    out = [LineOut(kind=e.kind, description=e.description, hsn=e.hsn, quantity=e.quantity, unit_price=e.unit_price,
                   tax_code=e.code, rate_percent=config.rate(e.code), line_amount=e.shown, discount=e.discount,
                   taxable=taxable[i], cgst=cgst[i], sgst=sgst[i], igst=igst[i], item_id=e.item_id)
           for i, e in enumerate(entries)]

    gross = sum(l.gross for l in out)
    payable = round_half_up(Fraction(gross, PAISE_PER_RUPEE)) * PAISE_PER_RUPEE if round_off else gross
    inv = Invoice(
        lines=out, document_type="tax_invoice" if config.active.collects_tax else "bill_of_supply",
        treatment=config.treatment, itc_eligible=config.active.itc_eligible, seller_state=config.seller_state,
        place_of_supply=pos, intra_state=intra, prices_include_tax=prices_include_tax, discount_amount=disc_total,
        discount_reason=reason, service_charge_percent=sc_pct if sc_amount > 0 else Decimal(0),
        taxable_total=sum(l.taxable for l in out), cgst=sum(cgst), sgst=sum(sgst), igst=sum(igst),
        total_before_round_off=gross, round_off=payable - gross, total=payable,
        invoice_number=invoice_number, invoice_date=iso_date(invoice_date, "invoice_date"),
        line_discount_amount=sum(line_disc))
    inv.breakup = breakup_by_rate(out)
    inv.hsn_summary = hsn_summary(out)
    return inv
