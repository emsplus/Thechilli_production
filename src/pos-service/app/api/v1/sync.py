from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.core.errors import CODES, CONFLICT_VALUE, INVALID_VALUE
from app.models.core import Bill, Order, SyncOperation
from app.schemas.sync import SyncBatchIn, SyncBatchOut, SyncOpIn, SyncResult
from app.services import billing, business_time, business_type, orders as order_svc, printing, wallet, waiter as waiter_svc

router = APIRouter(tags=["sync"])


def _order_by_client_uuid(db: Session, p: Principal, cu) -> Order:
    o = db.scalar(select(Order).where(Order.restaurant_id == p.restaurant_id, Order.client_uuid == cu))
    if not o:
        exc = HTTPException(409, "This order did not reach the system because an earlier step failed. Fix that step first.")
        exc.code = "order_not_found_yet"
        raise exc
    return o


# The permission each op needs: exactly the guard of its REST twin (tests/fixtures/route_roles.json). The batch endpoint
# itself only checks sync.push, so EVERY op type must be listed here (security review finding 2: a waiter could finalize
# bills and record cash payments through sync). An op type missing from this map is refused, never applied unchecked.
OP_PERMISSIONS: dict[str, str] = {
    "create_order": P.ORDERS_CREATE,         # POST /orders
    "add_lines": P.ORDERS_UPDATE,            # POST /orders/{id}/lines
    "send_kot": P.KOT_SEND,                  # POST /orders/{id}/kot
    "finalize_bill": P.BILLS_FINALIZE,       # POST /orders/{id}/bill
    "payment": P.PAYMENTS_RECORD,            # POST /bills/{id}/payments
    "open_shift": P.SHIFTS_USE,              # POST /waiter/shifts/open
    "close_shift": P.SHIFTS_USE,             # POST /waiter/shifts/close
    "request_bill": P.ORDERS_REQUEST_BILL,   # POST /orders/{id}/request-bill
}


class OpForbidden(Exception):
    """A permanent, per-op refusal: the caller lacks the permission. Never stored, so it is idempotent: resending the same
    op_id gets the same answer (and a later, legitimate sync by a user who has the permission still works)."""

    def __init__(self, perm: str):
        super().__init__(perm)
        self.perm = perm


def _need(p: Principal, perm: str) -> None:
    if not p.can(perm):  # the batch endpoint only checks sync.push: every op checks the permission of its REST twin
        raise OpForbidden(perm)


def _apply(db: Session, p: Principal, item: SyncOpIn, clock: business_time.BatchClock) -> dict:
    op = item.op
    perm = OP_PERMISSIONS.get(op.type)
    if perm is None:  # a new op type that nobody mapped: fail closed
        raise OpForbidden("unknown")
    _need(p, perm)  # before any lookup, so a denied op learns nothing about orders or bills
    if op.type == "create_order":
        o = order_svc.create_order(db, p, op.order, op.accept_price_changes, client_at=clock.stamp(item.client_created_at),
                                wallet_guard=False)
        return {"order_id": str(o.id), "token_number": o.token_number}
    if op.type in ("open_shift", "close_shift"):
        if op.type == "open_shift":
            s, created = waiter_svc.open_shift(db, p, op.note, item.client_created_at)
            return {"shift_id": str(s.id), "created": created}
        s = waiter_svc.close_own_shift(db, p)
        return {"shift_id": str(s.id) if s else None, "closed": s is not None}
    o = _order_by_client_uuid(db, p, op.order_client_uuid)
    if op.type == "request_bill":
        o = order_svc.request_bill(db, p, o.id)
        return {"order_id": str(o.id), "bill_requested_at": o.bill_requested_at.isoformat()}
    if op.type == "add_lines":
        order_svc.add_lines(db, p, o.id, op.batch_uuid, op.lines, op.accept_price_changes)
        return {"order_id": str(o.id)}
    if op.type == "send_kot":
        try:
            with printing.replaying(item.client_created_at, "kot"):
                return {"kot": order_svc.send_kot(db, p, o.id).number}
        except order_svc.NothingToSend:  # replay after a crash between apply and record
            return {"kot": None}
    if op.type == "finalize_bill":
        # Never refused for the wallet: the bill was already finalized (and handed to the guest) on the device. It is still
        # metered, with the device's time (docs/PAYG_BILLING.md "Offline").
        with printing.replaying(item.client_created_at, "bill"), wallet.replaying(item.client_created_at):
            b = billing.finalize_bill(db, p, o.id, op.discount, op.service_charge, op.apply_offers,
                                      client_at=clock.stamp(item.client_created_at))
        return {"invoice_number": b.invoice_number, "total": str(b.total)}
    bill = db.scalar(select(Bill).where(Bill.order_id == o.id, Bill.status == "active"))
    if not bill:
        exc = HTTPException(409, "This order has no bill yet. Make the bill first.")
        exc.code = "bill_missing"
        raise exc
    due = bill.total - billing.paid_total(bill)
    if due > 0:
        try:
            billing.add_payment(db, p, bill.id, item.op_id, op.method, due, client_at=clock.stamp(item.client_created_at))  # op_id doubles as payment key
        except HTTPException as e:
            if getattr(e, "code", None) != "payment_too_much":
                raise
            # another device's payment for this bill committed after `due` was read (add_payment re-checks under the bill lock):
            # settle what is left now, which is usually nothing (BREAK_BACKEND_REPORT.md D1)
            db.rollback()
            bill = db.get(Bill, bill.id, populate_existing=True)
            db.expire(bill, ["payments"])
            due = bill.total - billing.paid_total(bill)
            if due > 0:
                billing.add_payment(db, p, bill.id, item.op_id, op.method, due, client_at=clock.stamp(item.client_created_at))
            else:
                due = Decimal("0.00")
    return {"invoice_number": bill.invoice_number, "paid": str(due)}


@router.post("/sync/operations", response_model=SyncBatchOut)
def sync_operations(batch: SyncBatchIn, p: Principal = Depends(require_perm(P.SYNC_PUSH)),
                    db: Session = Depends(get_db)):
    """Applies operations in order. Already-applied op_ids return their stored result.
    Failures/conflicts are NOT stored, so the client may fix and resend the same op_id."""
    results: list[SyncResult] = []
    clock = business_time.BatchClock(batch.client_sent_at, billing.db_now(db))  # one clock correction for the whole batch
    for item in batch.operations:
        prior = db.scalar(select(SyncOperation).where(
            SyncOperation.restaurant_id == p.restaurant_id, SyncOperation.op_id == item.op_id))
        if prior:
            results.append(SyncResult(op_id=item.op_id, status="synced", data=prior.result))
            continue
        try:
            data = _apply(db, p, item, clock)
            db.add(SyncOperation(restaurant_id=p.restaurant_id, op_id=item.op_id, op_type=item.op.type,
                                 device_id=item.device_id, client_created_at=item.client_created_at, result=data))
            try:
                db.commit()
            except IntegrityError:  # concurrent duplicate delivery of the same op
                db.rollback()
            results.append(SyncResult(op_id=item.op_id, status="synced", data=data))
        except order_svc.PriceConflict as c:
            db.rollback()
            results.append(SyncResult(op_id=item.op_id, status="conflict", code="price_changed",
                                      detail="Some prices changed since this order was taken. Check the new prices.",
                                      conflicts=c.conflicts))
        except OpForbidden as e:
            db.rollback()
            results.append(SyncResult(op_id=item.op_id, status="failed", code="forbidden",
                                      detail=f"Not allowed for your role (missing permission: {e.perm})"))
        except business_type.NotAvailable as e:  # the business type does not allow the op: a conflict, never retried as is
            db.rollback()
            results.append(SyncResult(op_id=item.op_id, status="conflict", code=e.code, detail=str(e.detail)))
        except IntegrityError:  # a database rule refused THIS op (e.g. a unique race with another device): only this op fails
            db.rollback()
            again = db.scalar(select(SyncOperation).where(
                SyncOperation.restaurant_id == p.restaurant_id, SyncOperation.op_id == item.op_id))
            if again:  # the same op was applied by a concurrent delivery in the meantime: its stored result stands
                results.append(SyncResult(op_id=item.op_id, status="synced", data=again.result))
            else:      # never a 409 for the whole request: a client treats that as permanent for every op of the batch
                results.append(SyncResult(op_id=item.op_id, status="failed", code="conflict", detail=CONFLICT_VALUE))
        except DataError:  # a value the database refuses (NUL in a text, numeric overflow): this op fails, the batch goes on
            db.rollback()
            results.append(SyncResult(op_id=item.op_id, status="failed", code="invalid_value", detail=INVALID_VALUE))
        except HTTPException as e:
            db.rollback()
            # The same stable codes as the online endpoints (docs/ORDER_RULES.md). status stays "failed" (old devices treat
            # "conflict" as a price conflict); `code` says which rule refused the op.
            code = getattr(e, "code", None) or CODES.get(e.status_code, "error")
            results.append(SyncResult(op_id=item.op_id, status="failed", code=code, detail=str(e.detail),
                                      details=getattr(e, "details", None)))
    return SyncBatchOut(results=results)
