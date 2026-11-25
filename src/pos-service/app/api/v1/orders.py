import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.orm import Session, object_session

from app.api.deps import current_principal, P, Principal, require_perm
from app.core.db import get_db
from app.models.core import AuditLog, Kot, KotStatus, Order, OrderStatus
from app.schemas.common import (
    KitchenSummaryOut, KotOut, KotStatusIn, OrderCancelIn, OrderCustomerIn, OrderIn, OrderKotSummary, OrderLinePatch, OrderLinesIn, OrderOut, OrdersSummaryOut,
)
from app.schemas.waiter import OrderMergeIn, OrderNoteIn, OrderTransferIn, PaymentReminderDismissOut, PaymentReminderOut
from app.services.billing import paid_total
from app.services import audit, kitchen, order_kinds, order_rules, outlets, orders as svc, printing
from app.services.kot_slip import render_kot_slip
from app.services.reports import Ctx

router = APIRouter(tags=["orders"])


def _price_changed(c: svc.PriceConflict) -> HTTPException:
    """409 with the stable error code `price_changed` (error.code) and the conflicting lines (detail.conflicts)."""
    exc = HTTPException(409, {"message": "Some prices changed since this order was taken. Check the new prices and place it again.",
                              "conflicts": c.conflicts})
    exc.code = "price_changed"  # read by app.core.errors
    return exc


def _timestamps(o) -> None:
    """created_at / updated_at are server defaults: with expire_on_commit=False a freshly inserted row would answer null."""
    if getattr(o, "created_at", None) is None or getattr(o, "updated_at", None) is None:
        s = object_session(o)
        if s is not None and o in s:
            s.refresh(o, ["created_at", "updated_at"])


def _outs(orders: list[Order], db: Session | None = None) -> list[OrderOut]:
    """OrderOut with the subtotal and the kitchen tickets (one query for all orders)."""
    if not orders:
        return []
    db = db or object_session(orders[0])
    kots: dict = {}
    if db is not None:
        for k in db.scalars(select(Kot).where(Kot.order_id.in_([o.id for o in orders])).order_by(Kot.created_at, Kot.number)):
            kots.setdefault(k.order_id, []).append(k)
    outs = []
    for o in orders:
        _timestamps(o)
        out = OrderOut.model_validate(o)
        out.kind, out.merged_into_number, out.cancel_reason = order_kinds.kind_of(o), order_kinds.merged_into_number(o), order_kinds.display_reason(o)
        out.subtotal = svc.order_subtotal(o)
        ks = kots.get(o.id, [])
        for k in ks:
            _timestamps(k)
        out.kots = [OrderKotSummary.model_validate(k, from_attributes=True) for k in ks]
        sent = [k.created_at for k in ks if k.created_at is not None]
        out.first_kot_at, out.last_kot_at = (min(sent), max(sent)) if sent else (None, None)
        outs.append(out)
    return outs


def _out(o: Order) -> OrderOut:
    return _outs([o])[0]


def _kot_outs(db: Session, kots: list[Kot]) -> list[KotOut]:
    orders = {o.id: o for o in db.scalars(select(Order).where(Order.id.in_({k.order_id for k in kots})))} if kots else {}
    outs = []
    for k in kots:
        _timestamps(k)
        out = KotOut.model_validate(k)
        o = orders.get(k.order_id)
        if o:
            out.table_id, out.token_number, out.order_note = o.table_id, o.token_number, o.note
            out.order_created_at = o.created_at
        outs.append(out)
    return outs


@router.post("/orders", response_model=OrderOut, status_code=201)
def create_order(data: OrderIn, p: Principal = Depends(require_perm(P.ORDERS_CREATE)), db: Session = Depends(get_db)):
    try:
        return _out(svc.create_order(db, p, data))
    except svc.PriceConflict as c:
        raise _price_changed(c)


@router.get("/orders", response_model=list[OrderOut])
def list_orders(status: Literal["open", "sent_to_kitchen", "billed", "cancelled", "merged"] | None = None, outlet_id: uuid.UUID | None = None,
                p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Orders of the request's outlet (X-Outlet-Id, default outlet), or of `outlet_id` when given. `status=cancelled` lists real
    cancellations only, `status=merged` the orders that were joined into another one (their `kind` says which; both have status cancelled)."""
    q = select(Order).where(Order.restaurant_id == p.restaurant_id,
                            Order.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)))
    if status == "merged":  # merged-away orders are their own kind, not cancellations
        q = q.where(Order.status == OrderStatus.cancelled, order_kinds.merged_clause())
    elif status == "cancelled":
        q = q.where(order_kinds.cancelled_clause())
    elif status:
        q = q.where(Order.status == OrderStatus(status))
    # lines in one extra query for the page, not one per order (BREAK_BACKEND_REPORT.md P1: 205 statements for 200 orders)
    return _outs(list(db.scalars(q.options(selectinload(Order.lines)).order_by(Order.created_at.desc()).limit(200))), db)


@router.get("/orders/summary", response_model=OrdersSummaryOut)
def orders_summary(outlet_id: uuid.UUID | None = None, from_date: date | None = None, to_date: date | None = None,
                   p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Counters of the Orders screen. `in_kitchen` = orders with at least one ticket on the Kitchen board right now (same query as
    GET /kot/summary: kitchen.in_kitchen_summary). Not the number of orders with status sent_to_kitchen: a billed order's tickets
    are done, and a ticket that cleared itself is no longer in the kitchen."""
    scope = outlets.scope(p, outlet_id, all_by_default=False)
    c = Ctx(db, p.restaurant_id, scope)
    d1 = from_date or order_rules.local_today(db, p.restaurant_id)
    start, end = c.window(d1, to_date or d1)
    return {**kitchen.in_kitchen_summary(db, p.restaurant_id, scope), "cancelled": len(order_kinds.cancelled_orders(c, start, end)),
            "merged": order_kinds.merged_count(c, start, end)}


@router.get("/orders/{order_id}", response_model=OrderOut)
def get_order(order_id: uuid.UUID, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    o = db.get(Order, order_id)
    if not o or o.restaurant_id != p.restaurant_id or not outlets.visible(p, o):
        raise HTTPException(404, "Order not found")
    return _out(o)


@router.post("/orders/{order_id}/lines", response_model=OrderOut)
def add_order_lines(order_id: uuid.UUID, data: OrderLinesIn, p: Principal = Depends(require_perm(P.ORDERS_UPDATE)),
                    db: Session = Depends(get_db)):
    """Add items to an order that is already placed / sent to the kitchen (until it is billed). The new lines go to
    the kitchen with the next POST /orders/{id}/kot. Price conflicts are a 409 like POST /orders."""
    try:
        return _out(svc.add_lines(db, p, order_id, data.batch_uuid, data.lines, data.accept_price_changes))
    except svc.PriceConflict as c:
        raise _price_changed(c)


def _with_print(db: Session, kots: list[Kot]) -> list[KotOut]:
    outs = _kot_outs(db, kots)
    for out, k in zip(outs, kots):
        out.print = order_rules.kot_print_status(db, k)
        out.needs_reprint = out.print["needs_reprint"]
    return outs


@router.post("/orders/{order_id}/kot", response_model=KotOut, status_code=201)
def submit_kot(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.KOT_SEND)),
               db: Session = Depends(get_db)):
    """Send the unsent items to the kitchen. `print` says what happened to the kitchen slip (docs/ORDER_RULES.md): a print
    problem never undoes the ticket; it comes back as status `failed` with `needs_reprint: true`."""
    return _with_print(db, [svc.send_kot(db, p, order_id)])[0]


def _order_kots(db: Session, p: Principal, order_id: uuid.UUID) -> list[Kot]:
    o = db.get(Order, order_id)
    if not o or o.restaurant_id != p.restaurant_id or not outlets.visible(p, o):
        raise HTTPException(404, "Order not found")
    return list(db.scalars(select(Kot).where(Kot.order_id == o.id).order_by(Kot.number)))


def _print_report(db: Session, order_id: uuid.UUID, kots: list[Kot]) -> dict:
    outs = _with_print(db, kots)
    return {"order_id": order_id, "needs_reprint": any(o.needs_reprint for o in outs), "kots": outs}


@router.get("/orders/{order_id}/print-status")
def order_print_status(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.PRINTING_USE)),
                       db: Session = Depends(get_db)):
    """The kitchen slips of the order: every KOT with its `print` outcome; `needs_reprint` when any slip did not print."""
    return _print_report(db, order_id, _order_kots(db, p, order_id))


@router.post("/orders/{order_id}/print/retry")
def retry_order_print(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.PRINTING_USE)),
                      db: Session = Depends(get_db)):
    """Print again every kitchen slip of the order that did not print (needs_reprint). Nothing to reprint = the current
    status, unchanged. Returns the same shape as GET /orders/{id}/print-status."""
    kots = _order_kots(db, p, order_id)
    for k in kots:
        if k.status != KotStatus.cancelled and order_rules.kot_print_status(db, k)["needs_reprint"]:
            printing.reprint_kot(db, p, k.id, None)
    return _print_report(db, order_id, kots)


@router.post("/orders/{order_id}/cancel", response_model=OrderOut)
def cancel_order(order_id: uuid.UUID, data: OrderCancelIn,
                 p: Principal = Depends(require_perm(P.ORDERS_CANCEL)),
                 db: Session = Depends(get_db)):
    return _out(svc.cancel_order(db, p, order_id, data.reason))


@router.post("/orders/{order_id}/cancel-unsent", response_model=OrderOut)
def cancel_unsent_order(order_id: uuid.UUID, data: OrderCancelIn,
                        p: Principal = Depends(require_perm(P.ORDERS_CANCEL_UNSENT)), db: Session = Depends(get_db)):
    """Waiter: cancel an order the kitchen has not been sent (no KOT yet; else 409 and a cashier / manager must cancel it)."""
    return _out(svc.cancel_order(db, p, order_id, data.reason, only_unsent=True))


@router.delete("/orders/{order_id}/lines/{line_id}", response_model=OrderOut)
def remove_order_line(order_id: uuid.UUID, line_id: uuid.UUID,
                      p: Principal = Depends(require_perm(P.ORDERS_CANCEL_UNSENT)), db: Session = Depends(get_db)):
    """Remove an item that has not been sent to the kitchen yet (409 once it is on a KOT, or when it is the last item)."""
    return _out(svc.remove_line(db, p, order_id, line_id))


@router.patch("/orders/{order_id}/lines/{line_id}", response_model=OrderOut)
def edit_order_line(order_id: uuid.UUID, line_id: uuid.UUID, data: OrderLinePatch,
                    p: Principal = Depends(require_perm(P.ORDERS_UPDATE)), db: Session = Depends(get_db)):
    """Change the quantity / note of an item the kitchen has NOT been sent yet (409 already_in_kitchen afterwards)."""
    return _out(svc.edit_line(db, p, order_id, line_id, data))


@router.post("/orders/{order_id}/request-bill", response_model=OrderOut)
def request_bill(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.ORDERS_REQUEST_BILL)),
                 db: Session = Depends(get_db)):
    """Idempotent: flags the order for the cashier (`bill_requested_at`); GET /bill-requests lists them."""
    return _out(svc.request_bill(db, p, order_id))


@router.post("/orders/{order_id}/remind-payment", response_model=PaymentReminderOut)
def remind_payment(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.ORDERS_REQUEST_BILL)), db: Session = Depends(get_db)):
    """The waiter asks the counter to take the payment of a billed, unpaid / part-paid order: a `payment_reminder` entry in
    GET /bill-requests. Idempotent per order per minute (`already_sent: true`, nothing new). 409 order_not_billed /
    order_cancelled / bill_not_payable / already_paid."""
    order, bill, already = svc.remind_payment(db, p, order_id)
    return PaymentReminderOut(order_id=order.id, already_sent=already, sent_at=order.bill_requested_at,
                              balance_due=bill.total - paid_total(bill), invoice_number=bill.invoice_number)


@router.post("/orders/{order_id}/dismiss-payment-reminder", response_model=PaymentReminderDismissOut)
def dismiss_payment_reminder(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.BILLS_FINALIZE)), db: Session = Depends(get_db)):
    """The counter clears a payment reminder it has seen. Idempotent."""
    return PaymentReminderDismissOut(order_id=order_id, dismissed=svc.dismiss_payment_reminder(db, p, order_id))


@router.post("/orders/{order_id}/transfer", response_model=OrderOut)
def transfer_order(order_id: uuid.UUID, data: OrderTransferIn, p: Principal = Depends(require_perm(P.ORDERS_TRANSFER)),
                   db: Session = Depends(get_db)):
    """Move the order to another free table of the same outlet (409 when that table has an open order: use merge)."""
    return _out(svc.transfer_order(db, p, order_id, data.table_id))


@router.post("/orders/{order_id}/merge", response_model=OrderOut)
def merge_order(order_id: uuid.UUID, data: OrderMergeIn, p: Principal = Depends(require_perm(P.ORDERS_TRANSFER)),
                db: Session = Depends(get_db)):
    """Merge this order into `into_order_id` (same outlet, both unbilled). Returns the surviving (target) order."""
    return _out(svc.merge_orders(db, p, order_id, data.into_order_id))


@router.put("/orders/{order_id}/note", response_model=OrderOut)
def set_order_note(order_id: uuid.UUID, data: OrderNoteIn, p: Principal = Depends(require_perm(P.ORDERS_UPDATE)),
                   db: Session = Depends(get_db)):
    """Set or clear (null / empty) the free-text note of an unbilled order."""
    return _out(svc.set_note(db, p, order_id, data.note))


@router.put("/orders/{order_id}/customer", response_model=OrderOut)
def set_order_customer(order_id: uuid.UUID, data: OrderCustomerIn, p: Principal = Depends(require_perm(P.ORDERS_UPDATE)),
                       db: Session = Depends(get_db)):
    """Attach, change or clear (null) the customer of an order until it is billed; the bill snapshots it at finalize."""
    return _out(svc.set_customer(db, p, order_id, data.customer_id))


@router.get("/kot", response_model=list[KotOut])
def list_kots(status: KotStatus | None = None, outlet_id: uuid.UUID | None = None,
              p: Principal = Depends(require_perm(P.KOT_VIEW)), db: Session = Depends(get_db)):
    q = select(Kot).where(Kot.restaurant_id == p.restaurant_id,
                          Kot.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)))
    if status:
        q = q.where(Kot.status == status)
    return _kot_outs(db, list(db.scalars(q.order_by(Kot.number.desc()).limit(200))))


@router.get("/kot/summary", response_model=KitchenSummaryOut)
def kot_summary(outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.KOT_VIEW)), db: Session = Depends(get_db)):
    """What the Kitchen board shows, as numbers: the same `in_kitchen` as GET /orders/summary (kitchen.in_kitchen_summary)."""
    return kitchen.in_kitchen_summary(db, p.restaurant_id, outlets.scope(p, outlet_id, all_by_default=False))


@router.patch("/kot/{kot_id}", response_model=KotOut)
def update_kot(kot_id: uuid.UUID, data: KotStatusIn,
               p: Principal = Depends(require_perm(P.KOT_UPDATE_STATUS)),
               db: Session = Depends(get_db)):
    """Track mode: new -> preparing -> ready -> served (or cancelled). KOT-only mode (default): only `cancelled` / `pending`
    (re-open) are accepted here, preparing / ready / served answer 409 `kitchen_status_off`; use POST /kot/{id}/done."""
    k = _locked_kot(db, p, kot_id)
    kitchen.set_status(db, k, data.status)
    from app.services import delivery
    delivery.after_kot_status(db, k)  # delivery orders: preparing / ready move the delivery state + webhook (no-op otherwise)
    audit.record(db, p, "kot.status", "kot", k.id, {"status": data.status.value})
    db.commit()
    return _kot_outs(db, [k])[0]


@router.post("/kot/{kot_id}/done", response_model=KotOut)
def kot_done(kot_id: uuid.UUID, p: Principal = Depends(require_perm(P.KOT_UPDATE_STATUS)),
             db: Session = Depends(get_db)):
    """The kitchen is done with the ticket (the one step of KOT-only mode; also allowed in track mode as a shortcut to served).
    Idempotent. Delivery orders move to `ready` (webhook) like a kitchen that marked it ready."""
    k = _locked_kot(db, p, kot_id)
    if kitchen.mark_done(db, k):
        from app.services import delivery
        delivery.after_kot_done(db, k)
        audit.record(db, p, "kot.done", "kot", k.id, {"number": k.number})
    db.commit()
    return _kot_outs(db, [k])[0]


def _locked_kot(db: Session, p: Principal, kot_id: uuid.UUID) -> Kot:
    k = db.get(Kot, kot_id, with_for_update=True)  # serialise with order cancellation
    if not k or k.restaurant_id != p.restaurant_id or not outlets.visible(p, k):
        raise HTTPException(404, "Kitchen ticket not found")
    if k.status == KotStatus.cancelled:
        raise HTTPException(409, "This kitchen ticket was cancelled")
    return k


@router.get("/kot/{kot_id}/slip.pdf")
def kot_slip(kot_id: uuid.UUID, p: Principal = Depends(require_perm(P.KOT_VIEW)),
             db: Session = Depends(get_db)):
    k = db.get(Kot, kot_id)
    if not k or k.restaurant_id != p.restaurant_id or not outlets.visible(p, k):
        raise HTTPException(404, "Kitchen ticket not found")
    printed = db.scalar(select(AuditLog.id).where(
        AuditLog.restaurant_id == p.restaurant_id, AuditLog.action == "kot.slip.download",
        AuditLog.entity_id == str(k.id)).limit(1)) is not None
    pdf = render_kot_slip(db, k, reprint=printed)
    audit.record(db, p, "kot.slip.download", "kot", k.id, {"number": k.number})
    db.commit()
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="KOT-{k.number}.pdf"'})
