"""Correct a FINALIZED bill, the way accountants expect it: the original invoice is never modified. A correction
(one transaction) creates
  * a CREDIT NOTE (CN-<year>-######, `refunds.kind = 'amendment'`) that cancels the original in full, and
  * a REPLACEMENT invoice (new INV number) computed by the normal tax engine from the edited lines,
and marks the original `superseded`. The replacement keeps the ORIGINAL sale date (`sale_at`; date reports use it)
while `finalized_at` is the posting time (till X/Z periods use it), so a closed Z report is never touched: the
correction shows up in the period in which it is posted (Z-report CORRECTIONS block, see services/zreport.py).

Money: the replacement is settled from the original's payments through a `credit_note` payment of
min(paid, new total). If the customer paid more than the new total the difference is handed back (method chosen by
the user, recorded on the credit note as payout_*); if less, the replacement carries a balance due that the cashier
takes with the normal payment flow.

Only owners / managers (route), only the current version of a bill, within restaurant.bill_amend_days of the sale
date, never when the bill has a refund. Concurrency: shared `lock_activity` (so the posting lands in exactly one Z
period) then a row lock on the bill (two amendments / an amendment racing a refund or payment: one winner)."""
import uuid
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.core import (
    AuditLog, Bill, BillLine, Category, DiningTable, InventoryItem, MenuItem, MenuVariant, MovementType, Order, Payment,
    PaymentMethod, Refund, Restaurant, StockMovement,
)
from app.schemas.common import BillOut
from app.services import alerts, audit, billing, gst, inventory, outlets as outlets_svc, tax

ZERO = Decimal("0.00")
PAISA = Decimal("0.01")
PRESET_REASONS = ("Wrong item", "Wrong quantity", "Customer changed order", "Price mistake", "Other")


# ------------------------------------------------------------------ chain / eligibility
def chain_of(db: Session, bill: Bill) -> list[Bill]:
    """Every version of this sale, oldest first (replacements share the original's order)."""
    return list(db.scalars(select(Bill).where(Bill.restaurant_id == bill.restaurant_id, Bill.order_id == bill.order_id)
                           .order_by(Bill.finalized_at, Bill.id)))


def _sale_local_date(r: Restaurant, bill: Bill):
    return bill.sale_at.astimezone(ZoneInfo(r.timezone)).date()


def window_end(r: Restaurant, bill: Bill) -> datetime:
    """Local midnight after the last allowed day (sale date + bill_amend_days)."""
    last = _sale_local_date(r, bill) + timedelta(days=r.bill_amend_days)
    return datetime.combine(last + timedelta(days=1), time.min, tzinfo=ZoneInfo(r.timezone))


def _has_refund(db: Session, chain: list[Bill]) -> bool:
    return db.scalar(select(func.count(Refund.id)).where(
        Refund.bill_id.in_([b.id for b in chain]), Refund.kind == "refund")) > 0


def why_not(db: Session, r: Restaurant, bill: Bill, chain: list[Bill], now: datetime, pre_payment: bool = False) -> str | None:
    """pre_payment: the bill has no payment yet (a discount added before the customer pays): the restaurant's correction
    window (and its "turned off" switch) is about corrections AFTER the sale and does not apply; everything else does."""
    if r.bill_amend_days <= 0 and not pre_payment:
        return "Bill corrections are turned off (Manage > Restaurant > Bills can be corrected for N days)"
    if bill.status != "active":
        head = next((b for b in reversed(chain) if b.status == "active"), None)
        return (f"{bill.invoice_number} was already corrected and replaced by "
                f"{head.invoice_number if head else 'a newer invoice'}; correct that one instead")
    if _has_refund(db, chain):
        return f"{bill.invoice_number} has a refund / credit note against it, so it cannot be corrected"
    if not pre_payment and now >= window_end(r, bill):
        return (f"The correction window of {r.bill_amend_days} day(s) from the sale date "
                f"({_sale_local_date(r, bill).isoformat()}) has passed")
    return None


def refundable_by_method(db: Session, chain: list[Bill]) -> dict[str, Decimal]:
    ids = [b.id for b in chain]
    out = {m: ZERO for m in ("cash", "card", "upi", "other")}
    for m, a in db.execute(select(Payment.method, func.sum(Payment.amount)).where(
            Payment.bill_id.in_(ids), Payment.method != PaymentMethod.credit_note).group_by(Payment.method)):
        out[m.value] += Decimal(a)
    for m, a in db.execute(select(Refund.payout_method, func.sum(Refund.payout_amount)).where(
            Refund.bill_id.in_(ids), Refund.kind == "amendment", Refund.payout_amount > 0).group_by(Refund.payout_method)):
        if m in out:
            out[m] -= Decimal(a)
    return out


def _load(db: Session, p, bill_id: uuid.UUID, lock: bool = False) -> Bill:
    q = select(Bill).where(Bill.id == bill_id, Bill.restaurant_id == p.restaurant_id)
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    b = db.scalar(q)
    if not b or not outlets_svc.visible(p, b):
        raise HTTPException(404, "Bill not found")
    return b


def _link(b: Bill) -> dict:
    return {"id": b.id, "invoice_number": b.invoice_number, "status": b.status, "total": b.total,
            "sale_at": b.sale_at.isoformat(), "posted_at": b.finalized_at.isoformat()}


def options(db: Session, p, bill_id: uuid.UUID) -> dict:
    bill = _load(db, p, bill_id)
    r = db.get(Restaurant, p.restaurant_id)
    chain = chain_of(db, bill)
    head = next((b for b in reversed(chain) if b.status == "active"), chain[-1])
    reason = why_not(db, r, bill, chain, billing.db_now(db))
    return {"amendable": reason is None, "reason_if_not": reason, "amend_days": r.bill_amend_days,
            "window_ends_at": window_end(r, bill).isoformat() if r.bill_amend_days > 0 else None,
            "current_version_id": head.id, "chain": [_link(b) for b in chain],
            "refundable_by_method": refundable_by_method(db, chain)}


# ------------------------------------------------------------------ planning (no writes)
def _original_discount(db: Session, bill: Bill) -> tax.DiscountIn | None:
    if not bill.discount_amount or bill.discount_amount <= 0:
        return None
    reason = bill.discount_reason or "Discount"
    row = db.scalar(select(AuditLog).where(
        AuditLog.restaurant_id == bill.restaurant_id, AuditLog.action == "bill.discount",
        AuditLog.entity_id == str(bill.id)).order_by(AuditLog.created_at.desc()).limit(1))
    d = row.detail if row and row.detail else {}
    if d.get("type") in ("percent", "amount") and d.get("value") is not None:
        return tax.DiscountIn(d["type"], Decimal(str(d["value"])), reason)
    items = sum((l.line_total for l in bill.lines), ZERO)  # legacy: the effective percentage
    pct = (bill.discount_amount * 100 / items).quantize(PAISA) if items > 0 else Decimal(0)
    return tax.DiscountIn("percent", pct, reason) if pct > 0 else None


@dataclass
class Plan:
    restaurant: Restaurant
    bill: Bill
    invoice: tax.Invoice
    meta: list[dict]            # per engine line: bill_line_id, item_id, category_name, kept, price_source
    discount: tax.DiscountIn | None
    service_charge_removed: bool
    now: datetime
    table_label: str | None
    order_type: str | None


EAT_IN_AREAS = ("indoor", "outdoor")


def _target_table(db: Session, bill: Bill, table_id: uuid.UUID | None) -> tuple[str | None, str | None]:
    """(table_label, order_type) of the replacement: the original's, or the chosen table's (dine-in bills only)."""
    if table_id is None:
        return bill.table_label, bill.order_type
    if bill.order_type not in EAT_IN_AREAS:
        raise HTTPException(409, "Only dine-in (indoor / outdoor) bills can move to another table")
    t = db.get(DiningTable, table_id)
    if not t or t.restaurant_id != bill.restaurant_id or not t.is_active:
        raise HTTPException(404, "Table not found")
    if t.area.value not in EAT_IN_AREAS:
        raise HTTPException(422, f"Table {t.label} is not an indoor or outdoor table")
    return t.label, t.area.value


def plan(db: Session, p, bill: Bill, body, now: datetime) -> Plan:
    r = db.get(Restaurant, bill.restaurant_id)
    registered = bill.vat_registered
    rules = billing.applicable_rates(db, r, bill.sale_at)  # tax rates as at the SALE date
    if registered and "standard" not in rules:
        raise HTTPException(409, "No tax rule configured for the sale date")
    table_label, order_type = _target_table(db, bill, body.table_id)
    orig = {l.id: l for l in bill.lines}
    lines: list[tax.LineIn] = []
    meta: list[dict] = []
    for i, ln in enumerate(body.lines, 1):
        ol = orig.get(ln.bill_line_id) if ln.bill_line_id else None
        if ln.bill_line_id and ol is None:
            raise HTTPException(422, f"Line {i}: bill_line_id does not belong to this bill")
        kept = ol is not None and ln.variant_id is None and (ol.item_id is None or ol.item_id == ln.item_id)
        item = db.get(MenuItem, ln.item_id)
        if not item or item.restaurant_id != bill.restaurant_id:
            raise HTTPException(404, f"Line {i}: menu item not found")
        if kept:
            desc, price = ol.description, ol.unit_price
            code = ol.tax_code or tax.line_tax_code(registered)
            cat = ol.category_name
            source = "original"
        else:
            if not item.is_active:
                raise HTTPException(409, f"{item.name} is archived and cannot be added")
            desc, price = item.name, item.price
            if ln.variant_id:
                v = db.get(MenuVariant, ln.variant_id)
                if not v or v.item_id != item.id:
                    raise HTTPException(404, f"Line {i}: variant not found")
                if not v.is_active:
                    raise HTTPException(409, f"Option '{v.name}' of {item.name} is no longer available")
                price, desc = price + v.price_delta, f"{item.name} ({v.name})"
            code = tax.line_tax_code(registered)
            cat = db.scalar(select(Category.name).where(Category.id == item.category_id))
            source = "menu"
        if ln.unit_price_override is not None:
            reason = (ln.override_reason or "").strip()
            if not 3 <= len(reason) <= 200:
                raise HTTPException(422, f"Line {i}: a price override needs a reason of 3-200 characters")
            price, source = ln.unit_price_override, "override"
        lines.append(tax.LineIn(desc, ln.quantity, price, code, item.id))
        meta.append({"bill_line_id": ln.bill_line_id if kept else None, "item_id": item.id, "category_name": cat,
                     "kept": kept, "price_source": source,
                     "override_reason": (ln.override_reason or "").strip() if source == "override" else None})
    base = tax.item_total(lines)

    if "discount" in body.model_fields_set:
        disc = tax.DiscountIn(body.discount.type, body.discount.value, body.discount.reason) if body.discount else None
    else:
        disc = _original_discount(db, bill)
        if disc and disc.type == "amount":
            disc = tax.DiscountIn("amount", min(disc.value, base), disc.reason) if base > 0 else None
    if disc is not None:
        try:
            disc = tax.validate_discount(disc)
        except tax.TaxError as e:
            raise HTTPException(e.status, str(e))

    eat_in = tax.service_charge_applies(order_type)
    orig_pct = bill.service_charge_percent or Decimal(0)
    want_sc = body.service_charge if body.service_charge is not None else orig_pct > 0
    sc_pct, removed = Decimal(0), False
    if eat_in:
        if want_sc:
            sc_pct = orig_pct if orig_pct > 0 else r.service_charge_percent
        else:
            removed = (orig_pct > 0 or r.service_charge_percent > 0)
    try:
        if bill.tax_mode == gst.MODE_ON:  # India GST bill: the replacement is computed by the GST engine too
            inv = gst.amend_invoice(db, r, bill, lines, meta, disc, sc_pct)
        else:
            inv = tax.compute_invoice(lines, {c: x.rate_percent for c, x in rules.items()}, bill.prices_include_tax,
                                      sc_pct, disc, service_charge_code="standard" if registered else "none")
    except tax.TaxError as e:
        raise HTTPException(e.status, str(e))
    return Plan(r, bill, inv, meta, disc, removed, now, table_label, order_type)


def _paid(db: Session, bill_id: uuid.UUID) -> Decimal:
    return Decimal(db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.bill_id == bill_id)))


def _sale_usage(db: Session, bill_id: uuid.UUID) -> dict[uuid.UUID, Decimal]:
    """What the ledger recorded for this bill: base-unit quantity consumed per inventory item (positive)."""
    return {i: -Decimal(q) for i, q in db.execute(
        select(StockMovement.item_id, func.sum(StockMovement.quantity)).where(
            StockMovement.ref_id == bill_id, StockMovement.movement_type == MovementType.sale)
        .group_by(StockMovement.item_id))}


def _row(l: tax.LineOut, m: dict | None = None) -> dict:
    out = {"description": l.description, "quantity": l.quantity, "unit_price": l.unit_price,
           "line_total": l.line_total, "discount": l.discount, "gross": l.gross, "net": l.net, "vat": l.vat,
           "tax_code": l.tax_code, "rate_percent": l.rate_percent}
    if m:
        out.update(bill_line_id=m["bill_line_id"], item_id=m["item_id"], kept=m["kept"],
                   price_source=m["price_source"], override_reason=m["override_reason"])
    return out


def _diff(db: Session, pl: Plan, paid: Decimal) -> dict:
    b, inv = pl.bill, pl.invoice
    return {"old_total": b.total, "new_total": inv.total, "delta": inv.total - b.total,
            "old_vat": b.tax_amount, "new_vat": inv.tax_amount, "vat_delta": inv.tax_amount - b.tax_amount,
            "paid": paid, "refund_due": max(paid - inv.total, ZERO), "balance_due": max(inv.total - paid, ZERO)}


def _stock_impact(db: Session, pl: Plan) -> list[dict]:
    new, _ = inventory.recipe_usage(db, [(l.item_id, l.quantity) for l in pl.invoice.lines], pl.now)
    old = _sale_usage(db, pl.bill.id)
    ids = set(new) | set(old)
    names = {i.id: (i.name, i.base_unit) for i in db.scalars(select(InventoryItem).where(InventoryItem.id.in_(ids)))} if ids else {}
    out = []
    for i in sorted(ids, key=lambda x: names.get(x, ("", ""))[0]):
        delta = old.get(i, Decimal(0)) - new.get(i, Decimal(0))  # stock movement: + returns to stock, - consumed more
        if delta != 0:
            out.append({"item_id": i, "item_name": names[i][0], "delta_base_quantity": delta, "unit": names[i][1]})
    return out


def _ensure_amendable(db: Session, bill: Bill, r: Restaurant, now: datetime, pre_payment: bool = False) -> list[Bill]:
    chain = chain_of(db, bill)
    if (reason := why_not(db, r, bill, chain, now, pre_payment)):
        raise HTTPException(409, reason)
    return chain


def preview(db: Session, p, bill_id: uuid.UUID, body, pre_payment: bool = False) -> dict:
    bill = _load(db, p, bill_id)
    r = db.get(Restaurant, p.restaurant_id)
    now = billing.db_now(db)
    chain = _ensure_amendable(db, bill, r, now, pre_payment)
    pl = plan(db, p, bill, body, now)
    inv = pl.invoice
    paid = _paid(db, bill.id)
    return {"lines": [_row(l, m) for l, m in zip(inv.lines, pl.meta)],
            "discount_amount": inv.discount_amount, "discount_reason": inv.discount_reason,
            "discount": {"type": pl.discount.type, "value": pl.discount.value, "reason": pl.discount.reason} if pl.discount else None,
            "service_charge_amount": inv.service_charge_amount, "service_charge_percent": inv.service_charge_percent,
            "service_charge": _row(inv.service_charge) if inv.service_charge else None,
            "subtotal": inv.subtotal, "tax_amount": inv.tax_amount, "total": inv.total,
            "tax_breakdown": inv.tax_breakdown, "currency": bill.currency,
            "prices_include_tax": bill.prices_include_tax, "vat_registered": bill.vat_registered,
            "country": bill.country, "sale_at": bill.sale_at,
            "table_label": pl.table_label, "order_type": pl.order_type,
            "diff": _diff(db, pl, paid), "stock_impact": _stock_impact(db, pl),
            "refundable_by_method": refundable_by_method(db, chain)}


# ------------------------------------------------------------------ amend (writes)
def _lines_diff(old: list[BillLine], new: list[tax.LineOut]) -> dict:
    f = lambda d, q, u: f"{q} x {d} @ {u}"
    return {"before": [f(l.description, l.quantity, l.unit_price) for l in old],
            "after": [f(l.description, l.quantity, l.unit_price) for l in new]}


def amend(db: Session, p, bill_id: uuid.UUID, body, pre_payment: bool = False) -> tuple[Bill, Refund, bool]:
    """Returns (replacement bill, credit note, created). created=False = idempotent replay of the same key.
    pre_payment: see why_not (only the unpaid-bill discount path, services/billing.py, passes True)."""
    billing.lock_activity(db, billing.row_outlet(db, Bill, bill_id, p.restaurant_id))
    dup = db.scalar(select(Refund).where(Refund.restaurant_id == p.restaurant_id,
                                         Refund.idempotency_key == body.idempotency_key))
    if dup:
        if dup.kind != "amendment" or dup.replacement_bill_id is None:
            raise HTTPException(409, "This idempotency key was used for something else")
        root = _load(db, p, bill_id)
        if dup.bill_id not in {b.id for b in chain_of(db, root)}:
            raise HTTPException(409, "This idempotency key was used for another bill")
        return db.get(Bill, dup.replacement_bill_id), dup, False

    bill = _load(db, p, bill_id, lock=True)  # serialises amend / refund / payment on this bill
    r = db.scalar(select(Restaurant).where(Restaurant.id == p.restaurant_id).execution_options(populate_existing=True))
    posted = billing.db_now(db)  # stamped AFTER the shared lock: lands in exactly one Z period
    chain = _ensure_amendable(db, bill, r, posted, pre_payment)
    pl = plan(db, p, bill, body, posted)
    inv = pl.invoice
    paid = _paid(db, bill.id)
    diff = _diff(db, pl, paid)
    payout, method = ZERO, None
    if diff["refund_due"] > 0:
        method = body.refund_method
        if method is None:
            raise HTTPException(422, f"The customer paid {diff['refund_due']} more than the corrected total: "
                                     "choose how it is returned (refund_method: cash, card or other)")
        have = refundable_by_method(db, chain)[method]
        if diff["refund_due"] > have:
            raise HTTPException(409, f"Cannot return {diff['refund_due']} by {method}: only {have} was paid that way")
        payout = diff["refund_due"]
    elif body.refund_method is not None:
        method = None  # nothing to return: ignored

    restaurant = r
    orig_paid_credit = min(paid, inv.total)
    new_lines = []
    for i, (l, m) in enumerate(zip(inv.lines, pl.meta)):
        new_lines.append(BillLine(position=i, description=l.description, quantity=l.quantity, unit_price=l.unit_price,
                                  line_total=l.line_total, item_id=l.item_id, category_name=m["category_name"],
                                  tax_code=l.tax_code, tax_rate_percent=l.rate_percent, net_amount=l.net,
                                  vat_amount=l.vat, gross_amount=l.gross))
    std = billing.applicable_rates(db, r, bill.sale_at).get("standard")
    repl = Bill(
        restaurant_id=bill.restaurant_id, outlet_id=bill.outlet_id, order_id=bill.order_id,
        invoice_number=billing.next_number(db, restaurant, "INV", posted, bill.outlet_id),
        seller_name=bill.seller_name, seller_trn=bill.seller_trn, seller_address=bill.seller_address,
        seller_phone=bill.seller_phone, currency=bill.currency,
        tax_name=std.name if std and bill.vat_registered else bill.tax_name,
        tax_rate_percent=std.rate_percent if std and bill.vat_registered else bill.tax_rate_percent,
        subtotal=inv.subtotal, tax_amount=inv.tax_amount, total=inv.total, finalized_by=p.user_id,
        finalized_at=posted, sale_at=bill.sale_at,
        customer_name=bill.customer_name, customer_phone=bill.customer_phone, table_label=pl.table_label,
        order_type=pl.order_type, cashier_name=bill.cashier_name,
        country=bill.country, prices_include_tax=bill.prices_include_tax, vat_registered=bill.vat_registered,
        discount_amount=inv.discount_amount, discount_reason=inv.discount_reason,
        service_charge_amount=inv.service_charge_amount, service_charge_percent=inv.service_charge_percent,
        tax_breakdown=inv.tax_breakdown, lines=new_lines,
        status="active", amends_bill_id=bill.id, amended_at=posted, amended_by=p.user_id, amend_reason=body.reason)
    gst.decorate_bill(db, repl, inv, restaurant)  # India GST columns of the replacement; no-op otherwise
    billing.merge_identical_lines(repl)  # identical lines of a correction fold into one (same rule as a new bill)
    if repl.tax_mode == gst.MODE_ON:
        repl.customer_gstin, repl.customer_state_code = bill.customer_gstin, bill.customer_state_code
    db.add(repl)
    db.flush()
    bill.status, bill.superseded_by_bill_id = "superseded", repl.id  # the only change to the original row

    cn = Refund(restaurant_id=p.restaurant_id, outlet_id=bill.outlet_id, bill_id=bill.id, idempotency_key=body.idempotency_key,
                credit_note_number=billing.next_number(db, restaurant, "CN", posted, bill.outlet_id), kind="amendment",
                amount=bill.total, tax_amount=bill.tax_amount, reason=body.reason, created_by=p.user_id,
                created_at=posted, payout_amount=payout, payout_method=method if payout > 0 else None,
                replacement_bill_id=repl.id)
    gst.attach_credit_note(db, bill, cn, posted)  # India GST: full-reversal engine credit note (persisted to_dict)
    db.add(cn)
    if orig_paid_credit > 0:
        db.add(Payment(restaurant_id=p.restaurant_id, outlet_id=bill.outlet_id, bill_id=repl.id, idempotency_key=uuid.uuid4(),
                       method=PaymentMethod.credit_note, amount=orig_paid_credit, created_by=p.user_id,
                       created_at=posted))

    # ---- stock: reverse the original's consumption, post the replacement's (append-only)
    old_use = _sale_usage(db, bill.id)
    for item_id, qty in old_use.items():
        inventory.post(db, p.restaurant_id, item_id, MovementType.adjustment, qty, ref_id=bill.id, outlet_id=bill.outlet_id,
                       note=f"Sale reversed · bill {bill.invoice_number} superseded", user_id=p.user_id,
                       detail={"amend_reversal": True, "superseded_by": str(repl.id), "bill": bill.invoice_number})
    new_use, versions = inventory.recipe_usage(db, [(l.item_id, l.quantity) for l in inv.lines], posted)
    for item_id, qty in new_use.items():
        inventory.post(db, p.restaurant_id, item_id, MovementType.sale, -qty, ref_id=repl.id, user_id=p.user_id, outlet_id=bill.outlet_id,
                       detail={"order_id": str(bill.order_id), "recipe_versions": versions,
                               "corrects_bill_id": str(bill.id)})
    alerts.evaluate(db, p.restaurant_id, list(set(old_use) | set(new_use)))

    # ---- audit
    audit.record(db, p, "bill.amend", "bill", bill.id, {
        "original": bill.invoice_number, "replacement": repl.invoice_number, "replacement_id": str(repl.id),
        "credit_note": cn.credit_note_number, "reason": body.reason,
        "old_total": str(bill.total), "new_total": str(inv.total), "old_vat": str(bill.tax_amount),
        "new_vat": str(inv.tax_amount), "sale_at": bill.sale_at.isoformat(),
        "credit_applied": str(orig_paid_credit), "refund": str(payout), "refund_method": method if payout > 0 else None,
        "balance_due": str(diff["balance_due"]), "lines": _lines_diff(bill.lines, inv.lines),
        **({"table": {"from": bill.table_label, "to": pl.table_label, "from_area": bill.order_type,
                      "to_area": pl.order_type}} if (pl.table_label, pl.order_type) != (bill.table_label, bill.order_type) else {}),
        "overrides": [{"item": l.description, "unit_price": str(l.unit_price), "reason": m["override_reason"]}
                      for l, m in zip(inv.lines, pl.meta) if m["price_source"] == "override"]})
    audit.record(db, p, "credit_note.create", "bill", bill.id, {
        "credit_note": cn.credit_note_number, "amount": str(cn.amount), "tax": str(cn.tax_amount),
        "kind": "amendment", "replacement": repl.invoice_number})
    audit.record(db, p, "bill.finalize", "bill", repl.id, {
        "invoice": repl.invoice_number, "total": str(inv.total), "amends": bill.invoice_number,
        "discount": str(inv.discount_amount), "service_charge": str(inv.service_charge_amount)})
    if pl.discount is not None:
        audit.record(db, p, "bill.discount", "bill", repl.id, {
            "type": pl.discount.type, "value": str(pl.discount.value), "amount": str(inv.discount_amount),
            "reason": inv.discount_reason})
    if pl.service_charge_removed:
        audit.record(db, p, "bill.service_charge_removed", "bill", repl.id, {"percent": str(restaurant.service_charge_percent)})
    if payout > 0:
        audit.record(db, p, "refund.add", "bill", bill.id, {
            "amount": str(payout), "credit_note": cn.credit_note_number, "method": method,
            "reason": f"Bill correction: {body.reason}"})
    db.commit()
    db.refresh(repl)
    return repl, cn, True


# ------------------------------------------------------------------ BillOut decoration
def decorate(db: Session, bills: list[Bill]) -> list[BillOut]:
    """BillOut for each bill with amendment links resolved in a few batched queries (no N+1)."""
    outs = []
    if not bills:
        return outs
    order_ids = {b.order_id for b in bills}
    by_order: dict[uuid.UUID, list[Bill]] = {}
    for x in db.scalars(select(Bill).where(Bill.order_id.in_(order_ids)).order_by(Bill.finalized_at, Bill.id)):
        by_order.setdefault(x.order_id, []).append(x)
    mine = {b.id for b in bills}
    cn_by_bill = {bill_id: num for bill_id, num in db.execute(select(Refund.bill_id, Refund.credit_note_number).where(
        Refund.kind == "amendment", Refund.bill_id.in_({x.amends_bill_id for b in bills for x in [b] if x.amends_bill_id})))}
    for b in bills:
        o = BillOut.model_validate(b)
        members = by_order.get(b.order_id, [b])
        nums = {x.id: x.invoice_number for x in members}
        o.paid = billing.paid_total(b) - billing.refunded_total(b)
        o.balance_due = b.total - billing.paid_total(b) if b.status == "active" else ZERO
        o.superseded_by = b.superseded_by_bill_id
        o.superseded_by_number = nums.get(b.superseded_by_bill_id) if b.superseded_by_bill_id else None
        o.amends_number = nums.get(b.amends_bill_id) if b.amends_bill_id else None
        o.amends_credit_note = cn_by_bill.get(b.amends_bill_id) if b.amends_bill_id else None
        o.amendment_chain = [x.id for x in members] if len(members) > 1 else []
        outs.append(o)
    return outs
