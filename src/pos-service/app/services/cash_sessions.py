"""Cashier shifts and cash reconciliation (docs/CASH_SESSIONS.md).

A session is one cashier's shift at one outlet: opening float, then a counted amount at close.
  expected cash = opening float + cash payments - cash voids - cash refunds - cash handed back at corrections
over [opened_at, closed_at), all attributed to the user who RECORDED the movement (payments.created_by,
refunds.created_by) at that outlet. Voids are the negative cash payment rows services/void.py writes. Normal refunds carry no
method in this system, so they are treated as paid from the till in cash. variance = counted - expected; any non-zero
variance needs a reason. Closing snapshots expected / variance / breakdown; a closed session never changes."""
import uuid
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import CashSession, Payment, PaymentMethod, Refund, User
from app.schemas.cash_sessions import CashSessionOut
from app.services import billing, outlets as outlets_svc

ZERO = Decimal("0.00")


def _q(x) -> Decimal:
    return Decimal(x or 0).quantize(Decimal("0.01"))


def compute(db: Session, s: CashSession, end) -> dict:
    pay = {m.value: ZERO for m in PaymentMethod if m != PaymentMethod.credit_note}
    cash_in = voids = ZERO
    positive_col = (Payment.amount > 0).label("positive")
    for m, a, positive in db.execute(
            select(Payment.method, func.sum(Payment.amount), positive_col).where(
                Payment.restaurant_id == s.restaurant_id, Payment.outlet_id == s.outlet_id, Payment.created_by == s.cashier_id,
                Payment.created_at >= s.opened_at, Payment.created_at < end, Payment.method != PaymentMethod.credit_note)
            .group_by(Payment.method, positive_col)):
        pay[m.value] += Decimal(a)
        if m == PaymentMethod.cash:
            if positive:
                cash_in += Decimal(a)
            else:
                voids += -Decimal(a)
    base = (Refund.restaurant_id == s.restaurant_id, Refund.outlet_id == s.outlet_id, Refund.created_by == s.cashier_id,
            Refund.created_at >= s.opened_at, Refund.created_at < end)
    refunds = Decimal(db.scalar(select(func.coalesce(func.sum(Refund.amount), 0)).where(*base, Refund.kind == "refund")))
    payouts = Decimal(db.scalar(select(func.coalesce(func.sum(Refund.payout_amount), 0)).where(
        *base, Refund.kind == "amendment", Refund.payout_method == "cash")))
    expected = s.opening_float + cash_in - voids - refunds - payouts
    return {"expected": _q(expected), "breakdown": {
        "cash_payments": _q(cash_in), "cash_voids": _q(voids), "cash_refunds": _q(refunds),
        "cash_correction_payouts": _q(payouts), "by_method": {k: _q(v) for k, v in pay.items()}}}


def out(db: Session, s: CashSession) -> CashSessionOut:
    name = db.scalar(select(User.full_name).where(User.id == s.cashier_id))
    if s.status == "closed":
        expected, bd = s.expected_cash, s.breakdown
    else:
        c = compute(db, s, billing.db_now(db))
        expected, bd = c["expected"], c["breakdown"]
    return CashSessionOut(
        id=s.id, outlet_id=s.outlet_id, cashier_id=s.cashier_id, cashier_name=name, status=s.status, opened_at=s.opened_at,
        opening_float=s.opening_float, closed_at=s.closed_at, closed_by=s.closed_by, expected_cash=expected,
        counted_cash=s.counted_cash, variance=s.variance, variance_reason=s.variance_reason, breakdown=bd)


def open_session(db: Session, p, data) -> tuple[CashSession, bool]:
    if p.outlet_id is None:
        raise HTTPException(409, "No outlet to open a cash session in")
    if data.idempotency_key:
        dup = db.scalar(select(CashSession).where(CashSession.restaurant_id == p.restaurant_id,
                                                  CashSession.idempotency_key == data.idempotency_key))
        if dup:
            if dup.cashier_id != p.user_id:
                raise HTTPException(409, "This idempotency key was used by someone else")
            return dup, False
    cur = db.scalar(select(CashSession).where(CashSession.outlet_id == p.outlet_id, CashSession.cashier_id == p.user_id,
                                              CashSession.status == "open"))
    if cur:
        raise HTTPException(409, "You already have an open cash session at this outlet; close it first")
    s = CashSession(restaurant_id=p.restaurant_id, outlet_id=p.outlet_id, cashier_id=p.user_id, status="open",
                    opened_at=billing.db_now(db), opening_float=data.opening_float, idempotency_key=data.idempotency_key)
    db.add(s)
    from app.services import audit
    try:
        db.flush()
        audit.record(db, p, "cash_session.open", "cash_session", s.id, {"opening_float": str(data.opening_float)})
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "You already have an open cash session at this outlet; close it first")
    return s, True


def _load(db: Session, p, sid: uuid.UUID, lock: bool = False) -> CashSession:
    q = select(CashSession).where(CashSession.id == sid, CashSession.restaurant_id == p.restaurant_id)
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    s = db.scalar(q)
    if not s or not outlets_svc.visible(p, s) or (s.cashier_id != p.user_id and not p.can("reports.view")):
        raise HTTPException(404, "Cash session not found")
    return s


def get(db: Session, p, sid: uuid.UUID) -> CashSession:
    return _load(db, p, sid)


def current(db: Session, p) -> CashSession:
    s = db.scalar(select(CashSession).where(CashSession.outlet_id == p.outlet_id, CashSession.cashier_id == p.user_id,
                                            CashSession.status == "open"))
    if not s:
        raise HTTPException(404, "No open cash session")
    return s


def listing(db: Session, p, outlet_id: uuid.UUID | None, status: str | None, limit: int) -> list[CashSession]:
    q = select(CashSession).where(CashSession.restaurant_id == p.restaurant_id,
                                  CashSession.outlet_id.in_(outlets_svc.scope(p, outlet_id, all_by_default=False)))
    if not p.can("reports.view"):
        q = q.where(CashSession.cashier_id == p.user_id)
    if status:
        q = q.where(CashSession.status == status)
    return list(db.scalars(q.order_by(CashSession.opened_at.desc()).limit(limit)))


def close_session(db: Session, p, sid: uuid.UUID, data) -> CashSession:
    from app.services import audit
    s0 = _load(db, p, sid)
    billing.lock_activity(db, s0.outlet_id)  # payments of this outlet land either before or after the close
    s = _load(db, p, sid, lock=True)
    if s.status != "open":
        raise HTTPException(409, "This cash session is already closed")
    now = billing.db_now(db)
    c = compute(db, s, now)
    variance = _q(data.counted_cash) - c["expected"]
    reason = data.variance_reason
    if variance != 0 and not (reason and 3 <= len(reason) <= 300):
        raise HTTPException(422, f"Counted cash differs from expected by {variance}: a reason of 3-300 characters is required")
    s.status, s.closed_at, s.closed_by = "closed", now, p.user_id
    s.counted_cash, s.expected_cash, s.variance = _q(data.counted_cash), c["expected"], variance
    s.variance_reason = reason if variance != 0 else None
    s.breakdown = {k: (str(v) if not isinstance(v, dict) else {a: str(b) for a, b in v.items()}) for k, v in c["breakdown"].items()}
    audit.record(db, p, "cash_session.close", "cash_session", s.id, {
        "expected": str(c["expected"]), "counted": str(s.counted_cash), "variance": str(variance), "reason": s.variance_reason,
        "cashier_id": str(s.cashier_id)})
    db.commit()
    db.refresh(s)
    return s
