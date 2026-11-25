import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import Conflict
from app.models import PaymentIntent, ReconciliationRecord, Refund, Settlement
from app.schemas import SettlementIn
from app.services.audit import audit


def _match(db: Session, rec: ReconciliationRecord) -> None:
    if rec.item_type == "payment":
        i = db.scalars(select(PaymentIntent).where(
            PaymentIntent.tenant_id == rec.tenant_id, PaymentIntent.provider_payment_id == rec.provider_txn_id,
            PaymentIntent.captured_amount > 0)).first()
        target, expected = (i, i.captured_amount) if i else (None, None)
        intent_id = i.id if i else None
    else:
        r = db.scalars(select(Refund).where(
            Refund.tenant_id == rec.tenant_id, Refund.provider_refund_id == rec.provider_txn_id,
            Refund.status == "succeeded")).first()
        target, expected, intent_id = (r, r.amount, r.intent_id) if r else (None, None, None)
    rec.intent_id, rec.expected_amount = intent_id, expected
    if target is None:
        rec.status, rec.matched_at = "unmatched", None
    elif expected == rec.amount:
        rec.status, rec.matched_at = "matched", datetime.now(UTC)
    else:
        rec.status, rec.matched_at = "amount_mismatch", None


def import_settlement(db: Session, tenant_id: str, body: SettlementIn) -> tuple[Settlement, bool]:
    s = Settlement(tenant_id=tenant_id, provider=body.provider, settlement_ref=body.settlement_ref,
                   settled_at=body.settled_at)
    try:
        with db.begin_nested():
            db.add(s)
            db.flush()
    except IntegrityError:
        return db.scalars(select(Settlement).where(
            Settlement.tenant_id == tenant_id, Settlement.provider == body.provider,
            Settlement.settlement_ref == body.settlement_ref)).one(), False
    seen = set()
    for it in body.items:
        if (it.type, it.provider_txn_id) in seen:
            raise Conflict(f"duplicate item {it.provider_txn_id} in settlement", code="duplicate_item")
        seen.add((it.type, it.provider_txn_id))
        rec = ReconciliationRecord(tenant_id=tenant_id, settlement_id=s.id, item_type=it.type,
                                   provider_txn_id=it.provider_txn_id, amount=it.amount, fee=it.fee, tax=it.tax,
                                   status="unmatched")
        _match(db, rec)
        db.add(rec)
    audit(db, tenant_id, "service", "settlement_imported", None, settlement_ref=body.settlement_ref,
          items=len(body.items))
    db.commit()
    return s, True


def rematch(db: Session, tenant_id: str, settlement_id: uuid.UUID) -> list[ReconciliationRecord]:
    recs = db.scalars(select(ReconciliationRecord).where(
        ReconciliationRecord.tenant_id == tenant_id, ReconciliationRecord.settlement_id == settlement_id,
        ReconciliationRecord.status != "matched")).all()
    for r in recs:
        _match(db, r)
    db.commit()
    return list(recs)
