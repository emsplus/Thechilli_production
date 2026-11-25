"""Void a whole FINALIZED bill (POST /bills/{id}/void, permission bills.void).

The bill is never modified except its status (`voided`) and the void_* columns. One transaction creates
  * a full CREDIT NOTE (CN-<year>-######, `refunds.kind = 'void'`, same numbering/lock as services/amend.py, no
    replacement invoice),
  * for money already taken: one NEGATIVE payment per method (a cash-out / reversal record on the voided bill), and
    `payout_amount` on the credit note = the amount that must be handed back to the customer BY HAND. No gateway
    refund is attempted,
  * the reversal of the bill's stock consumption (append-only adjustment movements, as an amendment does),
  * audit rows (`bill.void`, `credit_note.create`).

Eligibility mirrors the amendment rules: only the current version of a bill, never when it has a refund, and the day
must not be closed: a bill posted before the outlet's last Z report can only be voided inside the correction window
(restaurant.bill_amend_days from the sale date). A bill of the still-open period can always be voided. The void is posted
now, so it lands in the current period and a closed Z report is never touched (Z report CORRECTIONS block).
Idempotent per key (Idempotency-Key header / body field); a bill cannot be voided twice."""
import uuid
from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.core import Bill, MovementType, Payment, PaymentMethod, Refund, Restaurant
from app.services import alerts, amend, audit, billing, inventory, wallet, zreport

ZERO = Decimal("0.00")


def _closed_day_block(db: Session, r: Restaurant, bill: Bill, now: datetime) -> str | None:
    if bill.finalized_at >= zreport.current_period_start(db, bill.restaurant_id, bill.outlet_id):
        return None  # the sale is in the still-open period
    if r.bill_amend_days > 0 and now < amend.window_end(r, bill):
        return None  # closed, but the existing amendment window still allows corrections
    return (f"The day of {bill.invoice_number} is closed (Z report) and the correction window has passed, "
            "so it cannot be voided")


def why_not(db: Session, r: Restaurant, bill: Bill, chain: list[Bill], now: datetime) -> str | None:
    if bill.status == "voided":
        return f"{bill.invoice_number} is already voided"
    if bill.status != "active":
        head = next((b for b in reversed(chain) if b.status == "active"), None)
        return (f"{bill.invoice_number} was corrected and replaced by "
                f"{head.invoice_number if head else 'a newer invoice'}; void that one instead")
    if amend._has_refund(db, chain):
        return f"{bill.invoice_number} has a refund / credit note against it, so it cannot be voided"
    return _closed_day_block(db, r, bill, now)


def _allocate(db: Session, bill: Bill, chain: list[Bill], paid: Decimal) -> dict[str, Decimal]:
    """Method split of the money to give back: the bill's own cash/card/upi/other payments; a replacement settled by a
    credit note gives back what the chain's customer really paid by method (amend.refundable_by_method)."""
    own: dict[str, Decimal] = {}
    credit = ZERO
    for m, a in db.execute(select(Payment.method, Payment.amount).where(Payment.bill_id == bill.id)):
        if m == PaymentMethod.credit_note:
            credit += Decimal(a)
        else:
            own[m.value] = own.get(m.value, ZERO) + Decimal(a)
    out = {m: a for m, a in own.items() if a > 0}
    left = credit
    if left > 0:
        for m, a in amend.refundable_by_method(db, chain).items():
            room = a - out.get(m, ZERO)
            take = min(left, room) if room > 0 else ZERO
            if take > 0:
                out[m] = out.get(m, ZERO) + take
                left -= take
        if left > 0:
            raise HTTPException(409, "The payments of this bill cannot be traced to a payment method")
    return out


def void_bill(db: Session, p, bill_id: uuid.UUID, reason: str, key: uuid.UUID) -> tuple[Bill, Refund, bool]:
    """Returns (bill, credit note, created). created=False = idempotent replay of the same key."""
    billing.lock_activity(db, billing.row_outlet(db, Bill, bill_id, p.restaurant_id))
    dup = db.scalar(select(Refund).where(Refund.restaurant_id == p.restaurant_id, Refund.idempotency_key == key))
    if dup:
        if dup.kind != "void" or dup.bill_id != bill_id:
            raise HTTPException(409, "This idempotency key was used for something else")
        return amend._load(db, p, bill_id), dup, False
    bill = amend._load(db, p, bill_id, lock=True)
    r = db.scalar(select(Restaurant).where(Restaurant.id == p.restaurant_id).execution_options(populate_existing=True))
    posted = billing.db_now(db)
    chain = amend.chain_of(db, bill)
    if (why := why_not(db, r, bill, chain, posted)):
        raise HTTPException(409, why)
    paid = amend._paid(db, bill.id)
    split = _allocate(db, bill, chain, paid) if paid > 0 else {}

    bill.status = "voided"
    bill.voided_at, bill.voided_by, bill.void_reason = posted, p.user_id, reason
    method = None if not split else (next(iter(split)) if len(split) == 1 else "mixed")
    cn = Refund(restaurant_id=p.restaurant_id, outlet_id=bill.outlet_id, bill_id=bill.id, idempotency_key=key,
                credit_note_number=billing.next_number(db, r, "CN", posted, bill.outlet_id), kind="void",
                amount=bill.total, tax_amount=bill.tax_amount, reason=reason, created_by=p.user_id, created_at=posted,
                payout_amount=paid, payout_method=method)
    db.add(cn)
    wallet.record_voided(db, bill)  # PAYG: the platform fee of this sale is credited back once (docs/PAYG_BILLING.md)
    for m, a in split.items():  # cash-out / reversal records; the customer is paid back by hand
        db.add(Payment(restaurant_id=p.restaurant_id, outlet_id=bill.outlet_id, bill_id=bill.id, idempotency_key=uuid.uuid4(),
                       method=PaymentMethod(m), amount=-a, created_by=p.user_id, created_at=posted))

    old_use = amend._sale_usage(db, bill.id)
    for item_id, qty in old_use.items():
        inventory.post(db, p.restaurant_id, item_id, MovementType.adjustment, qty, ref_id=bill.id,
                       note=f"Sale reversed · bill {bill.invoice_number} voided", user_id=p.user_id,
                       detail={"void_reversal": True, "bill": bill.invoice_number})
    alerts.evaluate(db, p.restaurant_id, list(old_use))

    audit.record(db, p, "bill.void", "bill", bill.id, {
        "invoice": bill.invoice_number, "credit_note": cn.credit_note_number, "reason": reason,
        "total": str(bill.total), "vat": str(bill.tax_amount), "sale_at": bill.sale_at.isoformat(),
        "refund_due": str(paid), "refund_due_by_method": {m: str(a) for m, a in split.items()},
        "stock_items_restored": len(old_use)})
    audit.record(db, p, "credit_note.create", "bill", bill.id, {
        "credit_note": cn.credit_note_number, "amount": str(cn.amount), "tax": str(cn.tax_amount), "kind": "void"})
    billing._commit_idempotent(db)
    db.refresh(bill)
    return bill, cn, True


def refund_due_by_method(db: Session, cn: Refund) -> dict[str, Decimal]:
    """What was recorded as handed back, per method (the negative payments posted with the credit note)."""
    out: dict[str, Decimal] = {}
    for m, a in db.execute(select(Payment.method, Payment.amount).where(
            Payment.bill_id == cn.bill_id, Payment.amount < 0, Payment.created_at == cn.created_at)):
        out[m.value] = out.get(m.value, ZERO) - Decimal(a)
    return out
