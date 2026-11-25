import json
import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.permissions import P
from app.models.core import (
    Bill, BillLine, CashSession, Category, InvoiceSequence, MenuItem, Order, Outlet, OrderStatus, Payment, PaymentMethod,
    Refund, Restaurant, TaxRate, User, Customer, DiningTable,
)
from app.services import audit, business_time, gst, inventory, kitchen, localisation as L, modifiers, order_rules, outlets, tax, wallet
from app.services.order_rules import RuleError
from app.services import feature_access
from app.services import offers as offers_svc
from app.services.outlets import seller_details as outlets_seller

PAISA = Decimal("0.01")


def money(x: Decimal) -> Decimal:
    return x.quantize(PAISA, rounding=ROUND_HALF_UP)


def _rule_rows(db: Session, restaurant: Restaurant, at: datetime) -> dict[str, TaxRate]:
    """Effective-dated rule lookup in the restaurant's local date: the latest valid row per tax code."""
    local = at.astimezone(ZoneInfo(restaurant.timezone)).date()
    rows = db.scalars(select(TaxRate).where(
        TaxRate.restaurant_id == restaurant.id, TaxRate.effective_from <= local,
    ).order_by(TaxRate.effective_from.desc())).all()
    out: dict[str, TaxRate] = {}
    for r in rows:
        if r.code not in out and (r.effective_to is None or r.effective_to >= local):
            out[r.code] = r
    return out


def applicable_rates(db: Session, restaurant: Restaurant, at: datetime) -> dict[str, TaxRate]:
    return _rule_rows(db, restaurant, at)


def applicable_tax(db: Session, restaurant: Restaurant, at: datetime) -> TaxRate:
    """The STANDARD rule (kept for /billing/tax-rate and legacy callers)."""
    rule = _rule_rows(db, restaurant, at).get("standard")
    if rule is None:
        raise HTTPException(409, "GST rates are not set up for today. Ask the owner to set them up in Settings.")
    return rule


def compute_totals(subtotal: Decimal, rate_percent: Decimal) -> tuple[Decimal, Decimal, Decimal]:
    """Prices are tax-exclusive. The tax is rounded once on the invoice total."""
    subtotal = money(subtotal)
    tax = money(subtotal * rate_percent / Decimal(100))
    return subtotal, tax, subtotal + tax


def _day_lock_key(outlet_id: uuid.UUID) -> str:
    return f"zday:{outlet_id}"  # the end-of-day lock is per OUTLET: closing outlet A never blocks outlet B


def row_outlet(db: Session, model, row_id: uuid.UUID, restaurant_id: uuid.UUID) -> uuid.UUID:
    """Outlet of an order / bill, read WITHOUT a row lock, so the (outlet) day lock can be taken before the row is locked
    (lock order: day lock, then row). A row never changes outlet, so this is safe. 404 when it is not this tenant's."""
    oid = db.scalar(select(model.outlet_id).where(model.id == row_id, model.restaurant_id == restaurant_id))
    if oid is None:
        raise HTTPException(404, "Order not found" if model is Order else "Bill not found")
    return oid


def lock_activity(db: Session, outlet_id: uuid.UUID) -> None:
    """SHARED transaction-level advisory lock taken by everything the end-of-day report counts (bill finalization,
    payments, refunds, order cancellation) BEFORE it stamps its timestamp. A Z close takes the same lock EXCLUSIVELY
    (zreport.lock_close), so it waits for in-flight activity to commit and holds new activity back until it has
    committed: a record is never stamped inside a period that was already summed without it."""
    db.execute(text("SELECT pg_advisory_xact_lock_shared(hashtextextended(:k, 0))"), {"k": _day_lock_key(outlet_id)})


def lock_close(db: Session, outlet_id: uuid.UUID) -> None:
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": _day_lock_key(outlet_id)})


def db_now(db: Session) -> datetime:
    """Wall-clock time at this instant (clock_timestamp), not the transaction start that now() would give."""
    return db.scalar(select(func.clock_timestamp()))


def next_counter(db: Session, restaurant_id: uuid.UUID, outlet_id: uuid.UUID, kind: str, year: int) -> int:
    """Row-locked gap-free counter, one per (outlet, kind, year). The increment lives in the caller's transaction, so a
    rollback gives the number back; the lock is held until commit, which serialises allocations of that outlet."""
    db.execute(pg_insert(InvoiceSequence).values(
        id=uuid.uuid4(), restaurant_id=restaurant_id, outlet_id=outlet_id, kind=kind, year=year, last_number=0,
    ).on_conflict_do_nothing(index_elements=["outlet_id", "kind", "year"]))
    seq = db.scalar(select(InvoiceSequence).where(
        InvoiceSequence.outlet_id == outlet_id, InvoiceSequence.kind == kind,
        InvoiceSequence.year == year).with_for_update())
    seq.last_number += 1
    return seq.last_number


GST_NUMBER_MAX = 16  # GST Rule 46 (invoices) and Rule 53 (credit notes): at most 16 characters, unique per financial year
IN_PREFIX_MAX = 4    # longest outlet invoice prefix, so the counter keeps 5+ digits


def fiscal_year_start(now_local: datetime, start_month: int) -> int:
    """First calendar year of the financial year containing `now_local` (April start: 2026-03-31 -> 2025, 2026-04-01 -> 2026)."""
    return now_local.year if now_local.month >= start_month else now_local.year - 1


def format_number_fy(kind: str, prefix: str, fy_start: int, n: int) -> str:
    """Indian series, financial year (Apr-Mar) and at most 16 characters (GST Rule 46):
    INV/2526/000042 and CN/2526/000003 for the default outlet; I<prefix>-2526-000042 / C<prefix>-2526-000003 for an outlet
    (a one-letter kind keeps the prefix room; the counter is zero-padded to whatever width is left, up to 6). The first
    character is the kind, so invoices and credit notes can never collide, and the separator tells the two shapes apart."""
    fy = f"{fy_start % 100:02d}{(fy_start + 1) % 100:02d}"
    if not prefix:
        out = f"{kind}/{fy}/{n:06d}"
    else:
        head = f"{kind[0]}{prefix}-{fy}-"
        out = head + f"{n:0{max(1, min(6, GST_NUMBER_MAX - len(head)))}d}"
    if len(out) > GST_NUMBER_MAX:
        raise HTTPException(409, f"Invoice number {out} would exceed {GST_NUMBER_MAX} characters (GST Rule 46): "
                                 "use a shorter outlet invoice prefix or contact support")
    return out


def next_number(db: Session, restaurant: Restaurant, kind: str, now: datetime, outlet_id: uuid.UUID) -> str:
    outlet = db.get(Outlet, outlet_id)
    if outlet is None or outlet.restaurant_id != restaurant.id:
        raise HTTPException(409, "Unknown outlet")
    if gst.applies(restaurant):  # India GST engine: engine numbering helper over the same gap-free counters
        return gst.next_number(db, restaurant, kind, now, outlet_id)
    local = now.astimezone(ZoneInfo(outlet.timezone))
    # The counter restarts every 1 April; `year` holds the first year of the financial year.
    fy = fiscal_year_start(local, L.FISCAL_YEAR_START_MONTH)
    return format_number_fy(kind, outlet.invoice_prefix, fy, next_counter(db, restaurant.id, outlet_id, kind, fy))


class BillPlan:
    """Everything needed to preview or persist a bill: the engine result plus the context it was computed in."""

    def __init__(self, restaurant: Restaurant, order: Order, invoice: tax.Invoice, rates: dict[str, TaxRate],
                 service_charge_removed: bool, now: datetime):
        self.restaurant, self.order, self.invoice, self.rates = restaurant, order, invoice, rates
        self.service_charge_removed, self.now = service_charge_removed, now
        self.at = now  # the sale's business time (the device's time for a plausible offline sale)
        # automatic offers (docs/MODIFIERS_OFFERS.md): applied, found-but-switched-off, and the split of the discount
        self.offers: list = []
        self.skipped_offers: list = []
        self.offer_amount = Decimal("0.00")
        self.manual_amount = Decimal("0.00")
        self.manual: tax.DiscountIn | None = None


def plan_bill(db: Session, p, order: Order, discount=None, service_charge: bool = True, apply_offers: bool = True,
              step_up: bool = False, at: datetime | None = None) -> BillPlan:
    """Computes the bill of an (unbilled) order from the SERVER-side prices. `discount` is a schemas DiscountIn.
    Enforces who may discount / remove the service charge. Applies the automatic offers that match (apply_offers=False:
    none). Does not write anything. Without a matching offer the computation is exactly the pre-offers one.
    step_up=True (the interactive bill routes, not the offline sync replay): a discount above the cashier cap by a user who
    may give one also needs a step-up token when STEP_UP_REQUIRED is on (docs/STAFF_PIN_DEVICES_API.md).
    `at` = the sale's business time when it differs from now (an offline sale replayed by sync, services/business_time.py): the
    tax rates are those in force at that time and the plan carries it as `plan.at`."""
    restaurant = db.get(Restaurant, order.restaurant_id)
    now = datetime.now(ZoneInfo("UTC"))
    rates = _rule_rows(db, restaurant, at or now)
    if at is not None and "standard" not in rates:  # no rate was in force at the device's time (e.g. the restaurant was set up
        rates = _rule_rows(db, restaurant, now)     # after it): book the bill with today's rates, never refuse a finished sale
    registered = restaurant.vat_registered
    if registered and "standard" not in rates:
        raise HTTPException(409, "GST rates are not set up for today. Ask the owner to set them up in Settings.")
    lines = [tax.LineIn(modifiers.describe(l.item_name, l.modifiers), l.quantity, l.unit_price, tax.line_tax_code(registered),
                        l.item_id) for l in order.lines]

    disc = None
    if discount is not None:
        feature_access.require(db, order.restaurant_id, "billing.discount")  # 403 feature_not_entitled / feature_switched_off
        if not p.can(P.BILLS_DISCOUNT):
            raise HTTPException(403, "You cannot give discounts. Ask a manager.")
        disc = tax.DiscountIn(discount.type, discount.value, discount.reason)
        try:
            disc = tax.validate_discount(disc)
        except tax.TaxError as e:
            raise HTTPException(e.status, str(e))

    amounts = [tax.money(l.unit_price * l.quantity) for l in lines]
    # Feature access: with "Automatic offers" off (super admin or the owner) no offer is found, applied or reported as skipped.
    found = offers_svc.for_order(db, order, amounts) if feature_access.allowed(db, order.restaurant_id, "billing.offers") else []
    applied = found if apply_offers else []
    line_disc, offer_total, manual_amt = None, Decimal("0.00"), Decimal("0.00")
    if applied:
        try:
            line_disc, offer_total, manual_amt = offers_svc.combine(applied, amounts, disc)
        except ValueError as e:
            raise HTTPException(422, str(e))
    over_limit = p.can(P.BILLS_DISCOUNT_OVER_LIMIT)
    if disc is not None and (not over_limit or (step_up and settings.step_up_required)):
        base = tax.item_total(lines)
        # with offers, the cap is checked on offers + the manual discount together (an offer never blocks a bill by itself)
        pct = ((offer_total + manual_amt) * 100 / base if base > 0 else Decimal(0)) if applied else tax.discount_percent_of(disc, base)
        if pct > restaurant.max_cashier_discount_percent:
            if not over_limit:  # the cashier cap applies to everyone without this permission
                raise HTTPException(403, f"Discounts above {restaurant.max_cashier_discount_percent.normalize():f}% "
                                         "need a manager or owner")
            from app.services import staff_pin
            staff_pin.require_step_up(p, "give a discount above the cashier limit")

    sc_pct = (restaurant.service_charge_percent if tax.service_charge_applies(order.order_type)
              and feature_access.allowed(db, order.restaurant_id, "billing.service_charge") else Decimal(0))
    removed = False
    if sc_pct > 0 and not service_charge:
        if not p.can(P.BILLS_DISCOUNT):
            raise HTTPException(403, "You cannot remove the service charge. Ask a manager.")
        sc_pct, removed = Decimal(0), True
    try:
        if applied:
            # Offers target lines, so both engines get the exact discount of every line (tax-engine-in >= 0.2.0 per-line
            # discounts): an item/category offer lowers only its own tax / GST rate group.
            reason = offers_svc.reason_of(applied, disc.reason if disc else None)
            inv = gst.plan_invoice(db, restaurant, order, None, sc_pct, line_discounts=line_disc,
                                   discount_reason=reason) or tax.compute_invoice(
                lines, {c: r.rate_percent for c, r in rates.items()}, restaurant.prices_include_tax,
                sc_pct, None, service_charge_code="standard" if registered else "none",
                line_discounts=line_disc, discount_reason=reason)
        else:
            inv = gst.plan_invoice(db, restaurant, order, disc, sc_pct) or tax.compute_invoice(
                lines, {c: r.rate_percent for c, r in rates.items()}, restaurant.prices_include_tax,
                sc_pct, disc, service_charge_code="standard" if registered else "none")
    except tax.TaxError as e:
        raise HTTPException(e.status, str(e))
    plan = BillPlan(restaurant, order, inv, rates, removed, now)
    plan.at = at or now
    plan.offers, plan.skipped_offers = applied, ([] if apply_offers else found)
    plan.offer_amount, plan.manual_amount, plan.manual = offer_total, manual_amt, disc
    return plan


def _line_key(item_id, description, unit_price, tax_code, modifiers, note) -> tuple:
    return (str(item_id), description, str(unit_price), tax_code, json.dumps(modifiers, sort_keys=True, default=str) if modifiers else "", (note or "").strip())


def merge_identical_lines(bill: Bill, notes: list[str | None] | None = None) -> None:
    """One bill line per identical order lines (tester bug 8, docs/testing/TESTER_BUGS_BACKEND_REPORT.md): lines with the same item,
    variant / modifiers (both are in the description and the modifiers snapshot), unit price, tax code and note (`notes[i]` = the note of
    the i-th line; none for lines that carry no note) become ONE line with the summed quantity and the summed amounts. The bill's
    totals, tax breakdown, discount and GST columns were computed on the split lines and are NOT touched, so the money is identical to the
    paisa; only the snapshot rows are folded (the order lines, KOT tickets and the stored GST document keep the split). Call after
    gst.decorate_bill (it pairs bill lines with engine lines by position) and before the bill is added."""
    out: dict[tuple, BillLine] = {}
    for i, bl in enumerate(bill.lines):
        k = _line_key(bl.item_id, bl.description, bl.unit_price, bl.tax_code, bl.modifiers, notes[i] if notes and i < len(notes) else None)
        first = out.get(k)
        if first is None:
            out[k] = bl
            continue
        first.quantity += bl.quantity
        for f in ("line_total", "net_amount", "vat_amount", "gross_amount", "cgst_amount", "sgst_amount", "igst_amount"):
            a, b = getattr(first, f), getattr(bl, f)
            setattr(first, f, b if a is None else a if b is None else a + b)
    merged = list(out.values())
    if len(merged) != len(bill.lines):
        bill.lines[:] = merged
        for pos, bl in enumerate(merged):
            bl.position = pos


def _merge_preview_rows(rows: list[dict], keys: list[tuple]) -> list[dict]:
    """The same folding for the bill-preview rows (so the preview shows what the bill will print)."""
    out: dict[tuple, dict] = {}
    for r, k in zip(rows, keys):
        first = out.get(k)
        if first is None:
            out[k] = dict(r)
            continue
        for f in ("quantity", "line_total", "discount", "gross", "net", "vat"):
            first[f] = first[f] + r[f]
    return list(out.values())


def preview_bill(db: Session, p, order_id: uuid.UUID, discount=None, service_charge: bool = True,
                 apply_offers: bool = True, step_up: bool = False) -> dict:
    order = db.get(Order, order_id)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    if db.scalar(select(Bill.id).where(Bill.order_id == order.id)) or order.status == OrderStatus.billed:
        raise RuleError(409, "order_billed", "This order already has a bill.")
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled.")
    if not order.lines:
        raise RuleError(422, "order_empty", "This order has no items.")
    plan = plan_bill(db, p, order, discount, service_charge, apply_offers, step_up=step_up)
    inv, r = plan.invoice, plan.restaurant

    def row(l: tax.LineOut) -> dict:
        return {"description": l.description, "quantity": l.quantity, "unit_price": l.unit_price,
                "line_total": l.line_total, "discount": l.discount, "gross": l.gross, "net": l.net, "vat": l.vat,
                "tax_code": l.tax_code, "rate_percent": l.rate_percent}
    keys = [_line_key(l.item_id, l.description, l.unit_price, l.tax_code, ol.modifiers, ol.note) for l, ol in zip(inv.lines, order.lines)]
    return {"lines": _merge_preview_rows([row(l) for l in inv.lines], keys), "discount_amount": inv.discount_amount,
            "discount_reason": inv.discount_reason, "service_charge_amount": inv.service_charge_amount,
            "offers": [a.as_dict() for a in plan.offers], "offer_amount": plan.offer_amount,
            "service_charge_percent": inv.service_charge_percent,
            "service_charge": row(inv.service_charge) if inv.service_charge else None,
            "subtotal": inv.subtotal, "tax_amount": inv.tax_amount, "total": inv.total,
            "tax_breakdown": inv.tax_breakdown, "currency": r.currency, "prices_include_tax": r.prices_include_tax,
            "vat_registered": r.vat_registered, "country": r.country, **gst.preview_extras(inv)}


def _auto_print(bill: Bill, user_id, existing: bool = False) -> None:
    try:
        from app.services import printing  # local import: printing pulls in the renderers
        printing.after_finalize(bill, user_id, existing=existing)
    except Exception:  # pragma: no cover - printing.after_finalize already swallows; belt and braces
        import logging
        logging.getLogger("app.printing").exception("auto-print hook failed")


def _current_version(db: Session, bill: Bill) -> Bill:
    """The bill that currently stands for the order: the original, or the newest correction of it."""
    seen = {bill.id}
    while bill.status == "superseded" and bill.superseded_by_bill_id and bill.superseded_by_bill_id not in seen:
        bill = db.get(Bill, bill.superseded_by_bill_id)
        seen.add(bill.id)
    return bill


def _manual_discount_of(db: Session, bill: Bill) -> tuple[str, Decimal] | None:
    """(type, value) of the manual discount the bill was made with, from its bill.discount audit row; None = no discount."""
    from app.models.core import AuditLog
    row = db.scalar(select(AuditLog).where(AuditLog.restaurant_id == bill.restaurant_id, AuditLog.action == "bill.discount",
                                           AuditLog.entity_id == str(bill.id)).order_by(AuditLog.created_at.desc()).limit(1))
    d = (row.detail or {}) if row else {}
    if "manual" in d:  # offers path: the manual part is nested
        d = d["manual"] or {}
    if d.get("type") in ("percent", "amount") and d.get("value") is not None:
        return d["type"], Decimal(str(d["value"]))
    return None


def _service_charge_removed(db: Session, bill: Bill) -> bool:
    from app.models.core import AuditLog
    return db.scalar(select(AuditLog.id).where(AuditLog.restaurant_id == bill.restaurant_id,
                                               AuditLog.action == "bill.service_charge_removed",
                                               AuditLog.entity_id == str(bill.id)).limit(1)) is not None


def _same_request(db: Session, bill: Bill, discount, service_charge: bool) -> bool:
    """Does a repeated bill request ask for the bill that already exists (same manual discount, same service charge)?"""
    want = (discount.type, Decimal(str(discount.value))) if discount is not None else None
    have = _manual_discount_of(db, bill)
    if (want is None) != (have is None) or (want and (want[0], want[1].normalize()) != (have[0], have[1].normalize())):
        return False
    if not service_charge and (bill.service_charge_amount or 0) > 0:
        return False
    if service_charge and _service_charge_removed(db, bill):
        return False
    return True


def _check_discount_cap(p, restaurant: Restaurant, discount, base: Decimal, step_up: bool) -> None:
    """The cashier cap on a discount (restaurants.max_cashier_discount_percent) for a discount that is changed on a bill that
    already exists: the same rule plan_bill applies to a new bill. Users with bills.discount.over_limit are not capped, but
    need a fresh step-up token above the cap when STEP_UP_REQUIRED is on (interactive routes only)."""
    if discount is None:
        return
    over_limit = p.can(P.BILLS_DISCOUNT_OVER_LIMIT)
    if over_limit and not (step_up and settings.step_up_required):
        return
    pct = tax.discount_percent_of(tax.DiscountIn(discount.type, discount.value, discount.reason), base)
    if pct > restaurant.max_cashier_discount_percent:
        if not over_limit:
            raise HTTPException(403, f"Discounts above {restaurant.max_cashier_discount_percent.normalize():f}% "
                                     "need a manager or owner")
        from app.services import staff_pin
        staff_pin.require_step_up(p, "give a discount above the cashier limit")


def _open_bill_guard(db: Session, p, bill: Bill) -> None:
    """A discount can only be added to / changed on a bill that is still open: the current version, active, nothing paid
    and nothing refunded. Paid bills are immutable here: after a payment only the manager's correction (credit note +
    replacement invoice, Orders > Edit this bill) or a refund can change the money."""
    if bill.status != "active":
        raise RuleError(409, "bill_not_open", f"Bill {bill.invoice_number} is no longer open, so its discount cannot be changed.",
                        bill_id=str(bill.id), invoice_number=bill.invoice_number)
    if paid_total(bill) > 0 or bill.refunds:
        raise RuleError(409, "bill_has_payment",
                        f"Bill {bill.invoice_number} already has a payment, so its discount cannot be changed here. "
                        "Ask a manager to correct the bill (credit note).",
                        bill_id=str(bill.id), invoice_number=bill.invoice_number)
    if any(l.item_id is None for l in bill.lines):
        raise RuleError(409, "bill_not_replaceable", f"Bill {bill.invoice_number} cannot be changed here. Ask a manager to correct it.",
                        bill_id=str(bill.id), invoice_number=bill.invoice_number)
    if (bill.offer_amount or 0) > 0:
        # the replacement invoice is computed from the bill's lines without the automatic offers: refuse instead of dropping them
        raise RuleError(409, "bill_has_offers",
                        f"Bill {bill.invoice_number} has an automatic offer, so its discount cannot be changed here. "
                        "Ask a manager to correct the bill.", bill_id=str(bill.id), invoice_number=bill.invoice_number)


def _replace_bill(db: Session, p, order: Order, bill: Bill, discount, service_charge: bool, reason: str | None,
                  step_up: bool = False) -> Bill:
    """Correct an UNPAID bill to the new discount / service charge in one step: credit note + replacement bill (services/amend.py),
    so the invoice-number series stays gap-free and nothing is deleted. Idempotent: the same change again replays."""
    from app.services import amend as amend_svc  # local import: amend imports this module
    from app.schemas.amend import AmendIn
    if not p.can(P.BILLS_DISCOUNT):
        raise RuleError(403, "manager_required", "You cannot change a discount. Ask a manager.")
    _open_bill_guard(db, p, bill)
    restaurant = db.get(Restaurant, order.restaurant_id)
    _check_discount_cap(p, restaurant, discount, sum((l.line_total for l in bill.lines), Decimal("0")), step_up)
    if not service_charge and (bill.service_charge_amount or 0) > 0 and not p.can(P.BILLS_DISCOUNT):
        raise HTTPException(403, "You cannot remove the service charge. Ask a manager.")
    why = " ".join((reason or "").split()) or (
        f"Discount changed before payment: {discount.reason or 'Discount'}" if discount is not None else "Discount removed before payment")
    key = uuid.uuid5(uuid.NAMESPACE_URL, f"replace-bill:{bill.id}:{discount.type if discount else '-'}:"
                                         f"{Decimal(str(discount.value)).normalize() if discount else '-'}:{service_charge}")
    body = {"lines": [{"bill_line_id": str(l.id), "item_id": str(l.item_id), "quantity": l.quantity} for l in bill.lines],
            "discount": discount.model_dump() if discount is not None else None, "service_charge": service_charge,
            "reason": why[:300] if len(why) >= 3 else "Bill corrected", "idempotency_key": str(key)}
    repl, _cn, _created = amend_svc.amend(db, p, bill.id, AmendIn.model_validate(body), pre_payment=True)
    audit.record(db, p, "bill.replace_before_payment", "bill", repl.id,
                 {"original": bill.invoice_number, "replacement": repl.invoice_number, "reason": why,
                  "old_discount": str(bill.discount_amount or 0), "new_discount": str(repl.discount_amount or 0),
                  "old_total": str(bill.total), "new_total": str(repl.total),
                  "discount": {"type": discount.type, "value": str(discount.value), "reason": discount.reason} if discount is not None else None})
    db.commit()
    return repl


def _open_bill(db: Session, p, bill_id: uuid.UUID, lock: bool = False) -> tuple[Bill, Bill]:
    """(the bill asked for, the version that stands for the sale now). 404 for another tenant's / an invisible outlet's bill."""
    b = db.get(Bill, bill_id)
    if not b or b.restaurant_id != p.restaurant_id or not outlets.visible(p, b):
        raise HTTPException(404, "Bill not found")
    return b, _current_version(db, b)


def _keep_service_charge(db: Session, bill: Bill, service_charge: bool | None) -> bool:
    return service_charge if service_charge is not None else not _service_charge_removed(db, bill)


def preview_open_bill_discount(db: Session, p, bill_id: uuid.UUID, discount, service_charge: bool | None = None) -> dict:
    """The exact bill an open (unpaid) bill would become with this discount (None = no discount): same engine, same numbers
    as apply_open_bill_discount, nothing persisted. Same shape as the bill preview of an order."""
    from app.services import amend as amend_svc
    from app.schemas.amend import AmendLineIn, AmendPreviewIn
    if not p.can(P.BILLS_DISCOUNT):
        raise HTTPException(403, "You cannot give discounts. Ask a manager.")
    _, bill = _open_bill(db, p, bill_id)
    _open_bill_guard(db, p, bill)
    restaurant = db.get(Restaurant, bill.restaurant_id)
    _check_discount_cap(p, restaurant, discount, sum((l.line_total for l in bill.lines), Decimal("0")), step_up=False)
    body = AmendPreviewIn(lines=[AmendLineIn(bill_line_id=l.id, item_id=l.item_id, quantity=l.quantity) for l in bill.lines],
                          discount=discount, service_charge=_keep_service_charge(db, bill, service_charge))
    pl = amend_svc.plan(db, p, bill, body, db_now(db))
    inv = pl.invoice

    def row(l: tax.LineOut) -> dict:
        return {"description": l.description, "quantity": l.quantity, "unit_price": l.unit_price,
                "line_total": l.line_total, "discount": l.discount, "gross": l.gross, "net": l.net, "vat": l.vat,
                "tax_code": l.tax_code, "rate_percent": l.rate_percent}
    return {"lines": [row(l) for l in inv.lines], "discount_amount": inv.discount_amount, "discount_reason": inv.discount_reason,
            "offers": [], "offer_amount": Decimal("0.00"), "service_charge_amount": inv.service_charge_amount,
            "service_charge_percent": inv.service_charge_percent,
            "service_charge": row(inv.service_charge) if inv.service_charge else None,
            "subtotal": inv.subtotal, "tax_amount": inv.tax_amount, "total": inv.total, "tax_breakdown": inv.tax_breakdown,
            "currency": bill.currency, "prices_include_tax": bill.prices_include_tax, "vat_registered": bill.vat_registered,
            "country": bill.country, **gst.preview_extras(inv)}


def apply_open_bill_discount(db: Session, p, bill_id: uuid.UUID, discount, service_charge: bool | None = None,
                             reason: str | None = None, step_up: bool = False) -> Bill:
    """Add, change or remove (discount=None) the discount of a bill that is open (made, nothing paid yet): the issued invoice
    is never edited; it gets a credit note and a replacement invoice (_replace_bill). Needs bills.discount, respects the cashier
    cap, audited, idempotent (the same request again returns the bill that stands). A paid bill is refused (bill_has_payment)."""
    lock_activity(db, row_outlet(db, Bill, bill_id, p.restaurant_id))
    asked, current = _open_bill(db, p, bill_id)
    order = db.get(Order, current.order_id, with_for_update=True)
    # lock the bill that stands like a payment does, and re-read it: a payment that committed meanwhile must give the clean
    # 409 bill_has_payment of the guard, not a refund-method question from the correction (BREAK_BACKEND_REPORT.md D4)
    current = db.get(Bill, current.id, with_for_update=True, populate_existing=True)
    db.expire(current, ["payments", "refunds"])
    if not p.can(P.BILLS_DISCOUNT):
        raise RuleError(403, "manager_required", "You cannot give discounts. Ask a manager.")
    sc = _keep_service_charge(db, current, service_charge)
    if current.status == "active" and _same_request(db, current, discount, sc):
        return current  # idempotent: this is already the bill that stands
    return _replace_bill(db, p, order, current, discount, sc, reason, step_up=step_up)


def finalize_bill(db: Session, p, order_id: uuid.UUID, discount=None, service_charge: bool = True,
                  apply_offers: bool = True, skip_kitchen_reason: str | None = None, replace_existing: bool = False,
                  replace_reason: str | None = None, step_up: bool = False, client_at: business_time.ClientTime | None = None) -> Bill:
    """client_at: the device's time of an offline sale (sync replay only), clock-corrected. When plausible it becomes the sale's date (`sale_at`,
    invoice date, financial year of the invoice number); see services/business_time.py.
    Idempotent per order (docs/ORDER_RULES.md): the same request again returns the bill that exists. A request with a
    DIFFERENT discount / service charge is never silently dropped: 409 bill_already_exists, or (replace_existing) the unpaid
    bill is corrected in one step. A dine-in order with items the kitchen has not been sent is a 409 kitchen_ticket_required
    while restaurants.require_kot_before_bill is on (bills.skip_kitchen + skip_kitchen_reason overrides, audited).
    step_up (docs/STAFF_PIN_DEVICES_API.md): a discount above the cashier cap needs a fresh step-up token when
    STEP_UP_REQUIRED is on (the REST endpoint passes True; offline sync replays do not)."""
    lock_activity(db, row_outlet(db, Order, order_id, p.restaurant_id))
    order = db.get(Order, order_id, with_for_update=True)
    if not order or order.restaurant_id != p.restaurant_id or not outlets.visible(p, order):
        raise HTTPException(404, "Order not found")
    existing = db.scalar(select(Bill).where(Bill.order_id == order.id, Bill.amends_bill_id.is_(None)))
    if existing:
        current = _current_version(db, existing)
        if current.status != "active" or _same_request(db, current, discount, service_charge):
            _auto_print(current, p.user_id, existing=True)  # heals a missed auto-print of a fresh bill; deduplicated
            return current
        if replace_existing:
            return _replace_bill(db, p, order, current, discount, service_charge, replace_reason, step_up=step_up)
        db.commit()  # release the row lock
        raise RuleError(409, "bill_already_exists",
                        f"This order already has bill {current.invoice_number}, made with a different discount or service "
                        "charge. Open the bill to change it.",
                        bill_id=str(current.id), invoice_number=current.invoice_number, total=str(current.total),
                        discount_amount=str(current.discount_amount or 0),
                        service_charge_amount=str(current.service_charge_amount or 0),
                        can_replace=p.can(P.BILLS_DISCOUNT) and paid_total(current) == 0)
    if order.status == OrderStatus.cancelled:
        raise RuleError(409, "order_cancelled", "This order was cancelled.")
    if not order.lines:
        raise RuleError(422, "order_empty", "This order has no items.")
    _kitchen_first(db, p, order, skip_kitchen_reason)

    posted = db_now(db)
    sale_at, ignored = business_time.resolve(client_at, posted)
    offline_day = client_at is not None and not ignored  # a plausible device time decides the date; otherwise nothing changes
    plan = plan_bill(db, p, order, discount, service_charge, apply_offers, step_up=step_up, at=sale_at if offline_day else None)
    restaurant, inv, now = plan.restaurant, plan.invoice, plan.now
    std = plan.rates.get("standard")  # absent only when the restaurant is not GST registered

    customer = db.get(Customer, order.customer_id) if order.customer_id else None
    table = db.get(DiningTable, order.table_id) if order.table_id else None
    cashier = db.get(User, p.user_id)
    cat_names = dict(db.execute(select(MenuItem.id, Category.name).join(Category, Category.id == MenuItem.category_id)
                                .where(MenuItem.id.in_({l.item_id for l in order.lines}))).all())

    mods = [l.modifiers for l in order.lines]  # inv.lines are the order's lines, in order

    def bill_line(i: int, l: tax.LineOut) -> BillLine:
        return BillLine(position=i, description=l.description, quantity=l.quantity, unit_price=l.unit_price,
                        line_total=l.line_total, item_id=l.item_id, category_name=cat_names.get(l.item_id),
                        tax_code=l.tax_code, modifiers=mods[i] if i < len(mods) else None,
                        tax_rate_percent=l.rate_percent, net_amount=l.net, vat_amount=l.vat, gross_amount=l.gross)
    bill = Bill(
        customer_name=customer.name if customer else None, customer_phone=customer.phone if customer else None,
        table_label=table.label if table else None, order_type=order.order_type.value,
        cashier_name=cashier.full_name if cashier else None,
        restaurant_id=restaurant.id, outlet_id=order.outlet_id, order_id=order.id,
        invoice_number=next_number(db, restaurant, "INV", sale_at if offline_day else now, order.outlet_id),
        seller_name=restaurant.name, **outlets_seller(db, restaurant, order.outlet_id),
        finalized_at=posted, sale_at=sale_at if offline_day else posted,
        currency=restaurant.currency, tax_name=std.name if std else "No GST",
        tax_rate_percent=std.rate_percent if std else Decimal("0.00"),
        subtotal=inv.subtotal, tax_amount=inv.tax_amount, total=inv.total, finalized_by=p.user_id,
        country=restaurant.country, prices_include_tax=restaurant.prices_include_tax,
        vat_registered=restaurant.vat_registered, discount_amount=inv.discount_amount,
        discount_reason=inv.discount_reason, service_charge_amount=inv.service_charge_amount,
        service_charge_percent=inv.service_charge_percent, tax_breakdown=inv.tax_breakdown,
        lines=[bill_line(i, l) for i, l in enumerate(inv.lines)],
        offer_amount=plan.offer_amount,
        offers={"applied": [a.as_dict() for a in plan.offers], "manual_amount": str(plan.manual_amount),
                "manual_reason": plan.manual.reason if plan.manual else None} if plan.offers else None,
    )
    gst.decorate_bill(db, bill, inv, restaurant, customer)  # India GST columns; no-op for every other bill
    merge_identical_lines(bill, [l.note for l in order.lines])  # 2x + 1x of the same dish and options = one line of 3
    order.status = OrderStatus.billed
    order.bill_requested_at = None  # the waiter's "bring the bill" request is answered
    db.add(bill)
    db.flush()
    kitchen.done_for_bill(db, p, order.id)  # the food has gone out: the order's tickets leave the Kitchen board (done_at, audited)
    inventory.consume_for_order(db, order, bill.id, now, p.user_id)
    wallet.record_finalized(db, bill)  # PAYG metering row, committed with the bill (docs/PAYG_BILLING.md)
    business_time.record(db, p, "bill", bill.id, client_at, sale_at, posted, ignored)
    audit.record(db, p, "bill.finalize", "bill", bill.id,
                 {"invoice": bill.invoice_number, "total": str(inv.total),
                  "discount": str(inv.discount_amount), "service_charge": str(inv.service_charge_amount)})
    if plan.offers:
        audit.record(db, p, "bill.offer", "bill", bill.id,
                     {"offers": [a.as_dict() for a in plan.offers], "amount": str(plan.offer_amount)})
        # No top-level type/value: a later amendment replays the bill's effective discount percentage (services/amend.py).
        audit.record(db, p, "bill.discount", "bill", bill.id, {
            "amount": str(inv.discount_amount), "reason": inv.discount_reason, "offer_amount": str(plan.offer_amount),
            "manual": {"type": discount.type, "value": str(discount.value), "amount": str(plan.manual_amount)}
            if discount is not None else None})
    elif inv.discount_amount > 0:
        audit.record(db, p, "bill.discount", "bill", bill.id,
                     {"type": discount.type, "value": str(discount.value), "amount": str(inv.discount_amount),
                      "reason": inv.discount_reason})
    if plan.skipped_offers:
        audit.record(db, p, "bill.offers_skipped", "bill", bill.id, {"offers": [a.as_dict() for a in plan.skipped_offers]})
    if plan.service_charge_removed:
        audit.record(db, p, "bill.service_charge_removed", "bill", bill.id,
                     {"percent": str(restaurant.service_charge_percent)})
    db.commit()
    _auto_print(bill, p.user_id)  # after the commit, own session, never raises: printing cannot fail a sale
    return bill


def _kitchen_first(db: Session, p, order: Order, skip_reason: str | None) -> None:
    """Dine-in orders go to the kitchen before the bill (restaurants.require_kot_before_bill, default on)."""
    if order.order_type not in order_rules.DINE_IN:
        return
    if not db.scalar(select(Restaurant.require_kot_before_bill).where(Restaurant.id == order.restaurant_id)):
        return
    unsent = order_rules.unsent_items(db, order)
    if unsent == 0:
        return
    reason = " ".join((skip_reason or "").split())
    if reason and p.can(P.BILLS_SKIP_KITCHEN):
        if len(reason) < 3:
            raise HTTPException(422, "Write a short reason (at least 3 letters).")
        audit.record(db, p, "bill.skip_kitchen", "order", order.id, {"unsent_items": unsent, "reason": reason})
        return
    items = "1 item has" if unsent == 1 else f"{unsent} items have"
    raise RuleError(409, "kitchen_ticket_required", f"Send the order to the kitchen first. {items} not gone to the kitchen yet.",
                    order_id=str(order.id), unsent_items=unsent, can_override=p.can(P.BILLS_SKIP_KITCHEN))


def paid_total(bill: Bill) -> Decimal:
    return sum((x.amount for x in bill.payments), Decimal("0"))


def refunded_total(bill: Bill) -> Decimal:
    """Normal refunds only: the full-reversal credit note of an amendment is not a refund of money."""
    return sum((x.amount for x in bill.refunds if x.kind == "refund"), Decimal("0"))


def _same_bill(prior, bill: Bill) -> None:
    """An idempotency key replays the SAME request. Found on another bill it is a client bug (or an attempt to read another
    bill's payment through a replay): 409, and the other bill's row is never returned."""
    if prior.bill_id != bill.id:
        raise HTTPException(409, "This payment was already recorded on another bill. Start the payment again.")


def _commit_idempotent(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError:  # two concurrent requests with one key, on different bills (the unique key is per tenant)
        db.rollback()
        raise HTTPException(409, "This payment was already recorded on another bill. Start the payment again.")


def add_payment(db: Session, p, bill_id: uuid.UUID, key: uuid.UUID, method: PaymentMethod,
                amount: Decimal, client_at: business_time.ClientTime | None = None) -> Payment:
    lock_activity(db, row_outlet(db, Bill, bill_id, p.restaurant_id))
    # serialises concurrent payments. populate_existing: a caller (the offline sync replay) may already hold this bill with its
    # payments loaded BEFORE the lock; without a refresh paid_total() below would see that stale list and two racing devices
    # would both be booked in full (docs/testing/BREAK_BACKEND_REPORT.md D1).
    bill = db.get(Bill, bill_id, with_for_update=True, populate_existing=True)
    if not bill or bill.restaurant_id != p.restaurant_id or not outlets.visible(p, bill):
        raise HTTPException(404, "Bill not found")
    db.expire(bill, ["payments", "refunds"])
    dup = db.scalar(select(Payment).where(Payment.restaurant_id == p.restaurant_id,
                                          Payment.idempotency_key == key))
    if dup:
        _same_bill(dup, bill)
        return dup
    if bill.status != "active":
        if bill.status == "voided":
            raise RuleError(409, "bill_voided", f"Bill {bill.invoice_number} was cancelled. Nothing to pay.")
        raise RuleError(409, "bill_replaced", f"Bill {bill.invoice_number} was replaced by a newer bill. Take the payment on the new bill.",
                        replaced_by=str(bill.superseded_by_bill_id) if bill.superseded_by_bill_id else None)
    if method == PaymentMethod.credit_note:
        raise HTTPException(422, "Pick cash, card or UPI.")
    amount = money(amount)
    if amount <= 0:
        raise HTTPException(422, "Amount must be positive")
    if paid_total(bill) + amount > bill.total:
        raise RuleError(409, "payment_too_much", f"That is more than the amount left to pay ({bill.total - paid_total(bill)}). "
                                                 "Enter the bill amount and give the change.",
                        balance_due=str(bill.total - paid_total(bill)))
    posted = db_now(db)
    paid_at, ignored = business_time.resolve(client_at, posted)
    if client_at is not None and not ignored:
        from app.services import zreport  # zreport imports billing
        z = zreport.last_z(db, bill.restaurant_id, bill.outlet_id)  # never inside a Z period that is already closed
        if z is not None:
            paid_at = max(paid_at, z.period_to)
        # ... nor inside a cash session that is already closed (its expected cash is frozen at the close, INDEPENDENT_REVIEW M2)
        closed = db.scalar(select(func.max(CashSession.closed_at)).where(
            CashSession.restaurant_id == bill.restaurant_id, CashSession.outlet_id == bill.outlet_id, CashSession.status == "closed"))
        if closed is not None:
            paid_at = max(paid_at, closed)
        # ... and not before the opening of the caller's open session, which would leave it in no session at all
        opened = db.scalar(select(CashSession.opened_at).where(
            CashSession.outlet_id == bill.outlet_id, CashSession.cashier_id == p.user_id, CashSession.status == "open"))
        if opened is not None:
            paid_at = max(paid_at, opened)
        paid_at = min(paid_at, posted)
    pay = Payment(restaurant_id=p.restaurant_id, outlet_id=bill.outlet_id, bill_id=bill.id, idempotency_key=key,
                  method=method, amount=amount, created_by=p.user_id, created_at=paid_at)
    db.add(pay)
    if client_at is not None:
        db.flush()
        business_time.record(db, p, "payment", pay.id, client_at, paid_at, posted, ignored)
    audit.record(db, p, "payment.add", "bill", bill.id, {"amount": str(amount), "method": method.value})
    if paid_total(bill) + amount >= bill.total:  # settled: the waiter's "remind the counter" alert is answered
        paid_order = db.get(Order, bill.order_id)
        if paid_order is not None and paid_order.bill_requested_at is not None:
            paid_order.bill_requested_at = paid_order.bill_requested_by = None
    _commit_idempotent(db)
    return pay


def add_refund(db: Session, p, bill_id: uuid.UUID, key: uuid.UUID, amount: Decimal, reason: str) -> Refund:
    lock_activity(db, row_outlet(db, Bill, bill_id, p.restaurant_id))
    bill = db.get(Bill, bill_id, with_for_update=True, populate_existing=True)  # fresh payments / refunds (see add_payment)
    if not bill or bill.restaurant_id != p.restaurant_id or not outlets.visible(p, bill):
        raise HTTPException(404, "Bill not found")
    db.expire(bill, ["payments", "refunds"])
    dup = db.scalar(select(Refund).where(Refund.restaurant_id == p.restaurant_id,
                                         Refund.idempotency_key == key))
    if dup:
        _same_bill(dup, bill)
        return dup
    if bill.status != "active":
        raise HTTPException(409, f"{bill.invoice_number} was corrected and replaced by a newer invoice; refund that one")
    amount = money(amount)
    if amount <= 0:
        raise HTTPException(422, "Amount must be positive")
    if refunded_total(bill) + amount > paid_total(bill):
        raise HTTPException(409, "Refund exceeds amount paid")
    # One tax rate on the bill: amount * rate / (100 + rate). Several rates (standard + zero): pro-rata,
    # round(amount * bill.tax_amount / bill.total, 2).
    tax_part = tax.refund_tax(amount, bill.total, bill.tax_amount,
                              tax.single_rate_of(bill.tax_breakdown, bill.tax_rate_percent))
    restaurant = db.get(Restaurant, p.restaurant_id)
    now = datetime.now(ZoneInfo("UTC"))
    ref = Refund(restaurant_id=p.restaurant_id, outlet_id=bill.outlet_id, bill_id=bill.id, idempotency_key=key,
                 credit_note_number=next_number(db, restaurant, "CN", now, bill.outlet_id),
                 amount=amount, tax_amount=tax_part, reason=reason, created_by=p.user_id,
                 created_at=db_now(db))
    gst.attach_credit_note(db, bill, ref, now, amount)  # India GST: engine credit note replayed on the stored invoice
    db.add(ref)
    db.flush()
    audit.record(db, p, "refund.add", "bill", bill.id,
                 {"amount": str(amount), "credit_note": ref.credit_note_number, "reason": reason})
    _commit_idempotent(db)
    return ref
