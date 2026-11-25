import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import ADMIN, ANY_ROLE, Principal, require_roles, read_roles
from app.core.config import settings
from app.core.db import get_db
from app.core.security import utcnow
from app.models import CommissionEntry, CommissionRule, EntryKind, EntryStatus
from app.schemas.api import DecisionIn, EntryOut, RuleCreate, RuleOut, RuleUpdate
from app.services import audit

router = APIRouter(tags=["commissions"])


@router.post("/commission-rules", response_model=RuleOut, status_code=201)
def create_rule(body: RuleCreate, p: Principal = Depends(require_roles(*ADMIN)), db: Session = Depends(get_db)):
    r = CommissionRule(**body.model_dump(exclude={"currency"}), currency=(body.currency or settings.default_currency).upper(),
                       created_by=p.user_id)
    db.add(r)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A rule with this name already exists")
    audit.record(db, p.user_id, "commission_rule.created", "commission_rule", r.id)
    db.commit()
    return r


@router.get("/commission-rules", response_model=list[RuleOut])
def list_rules(p: Principal = Depends(read_roles(*ADMIN)), db: Session = Depends(get_db)):
    return list(db.scalars(select(CommissionRule).order_by(CommissionRule.created_at, CommissionRule.name)))


@router.patch("/commission-rules/{rule_id}", response_model=RuleOut)
def update_rule(rule_id: uuid.UUID, body: RuleUpdate, p: Principal = Depends(require_roles(*ADMIN)),
                db: Session = Depends(get_db)):
    """Only switch-off, end-date and cap are editable: amounts of a live rule never change (past entries keep a snapshot)."""
    r = db.get(CommissionRule, rule_id)
    if not r:
        raise HTTPException(404, "Rule not found")
    data = body.model_dump(exclude_unset=True)
    if data.get("is_active") is None:
        data.pop("is_active", None)
    for k, v in data.items():
        setattr(r, k, v)
    audit.record(db, p.user_id, "commission_rule.updated", "commission_rule", r.id, {"fields": sorted(data)})
    db.commit()
    return r


@router.get("/commission-entries", response_model=list[EntryOut])
def list_entries(status: EntryStatus | None = None, user_id: uuid.UUID | None = None,
                 limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                 p: Principal = Depends(read_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    q = select(CommissionEntry).order_by(CommissionEntry.created_at.desc(), CommissionEntry.id)
    if not p.is_admin:
        q = q.where(CommissionEntry.user_id == p.user_id)
    elif user_id:
        q = q.where(CommissionEntry.user_id == user_id)
    if status:
        q = q.where(CommissionEntry.status == status)
    return list(db.scalars(q.limit(limit).offset(offset)))


@router.get("/commission-entries/summary")
def summary(user_id: uuid.UUID | None = None, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    """Balances in integer minor units per currency: pending (awaiting approval), approved (owed, net of reversal
    rows) and paid."""
    target = user_id if (p.is_admin and user_id) else p.user_id
    rows = db.execute(select(CommissionEntry.currency, CommissionEntry.status, func.sum(CommissionEntry.amount_minor))
                      .where(CommissionEntry.user_id == target).group_by(CommissionEntry.currency, CommissionEntry.status))
    out: dict[str, dict[str, int]] = {}
    for cur, st, total in rows:
        out.setdefault(cur, {"pending_minor": 0, "approved_minor": 0, "paid_minor": 0})
        if st.value in ("pending", "approved", "paid"):
            out[cur][f"{st.value}_minor"] = int(total)
    return {"user_id": target, "balances": out}


def _locked(db, entry_id) -> CommissionEntry:
    e = db.scalar(select(CommissionEntry).where(CommissionEntry.id == entry_id).with_for_update())
    if not e:
        raise HTTPException(404, "Entry not found")
    return e


def _decide(db, p, entry_id, body: DecisionIn, allowed_from: EntryStatus, to: EntryStatus, action: str):
    e = _locked(db, entry_id)
    if e.user_id == p.user_id:
        raise HTTPException(403, "You cannot decide on your own commission (maker-checker)")
    if e.kind != EntryKind.commission or e.status != allowed_from:
        raise HTTPException(409, f"Entry is {e.status.value}; expected {allowed_from.value}")
    if to == EntryStatus.paid and db.scalar(select(CommissionEntry.id).where(CommissionEntry.reverses_entry_id == e.id)):
        raise HTTPException(409, "Entry has been reversed")
    e.status, e.decided_by, e.decided_at = to, p.user_id, utcnow()
    e.note = body.note or e.note
    audit.record(db, p.user_id, action, "commission_entry", e.id, {"amount_minor": e.amount_minor, "status": to.value})
    db.commit()
    return e


@router.post("/commission-entries/{entry_id}/approve", response_model=EntryOut)
def approve(entry_id: uuid.UUID, body: DecisionIn | None = None, p: Principal = Depends(require_roles(*ADMIN)),
            db: Session = Depends(get_db)):
    return _decide(db, p, entry_id, body or DecisionIn(), EntryStatus.pending, EntryStatus.approved, "commission.approved")


@router.post("/commission-entries/{entry_id}/reject", response_model=EntryOut)
def reject(entry_id: uuid.UUID, body: DecisionIn | None = None, p: Principal = Depends(require_roles(*ADMIN)),
           db: Session = Depends(get_db)):
    return _decide(db, p, entry_id, body or DecisionIn(), EntryStatus.pending, EntryStatus.rejected, "commission.rejected")


@router.post("/commission-entries/{entry_id}/pay", response_model=EntryOut)
def pay(entry_id: uuid.UUID, body: DecisionIn | None = None, p: Principal = Depends(require_roles(*ADMIN)),
        db: Session = Depends(get_db)):
    return _decide(db, p, entry_id, body or DecisionIn(), EntryStatus.approved, EntryStatus.paid, "commission.paid")


@router.post("/commission-entries/{entry_id}/reverse", response_model=EntryOut, status_code=201)
def reverse(entry_id: uuid.UUID, body: DecisionIn | None = None, p: Principal = Depends(require_roles(*ADMIN)),
            db: Session = Depends(get_db)):
    """Append a negative approved row that cancels an approved or paid entry (the original row is never edited)."""
    e = _locked(db, entry_id)
    if e.kind != EntryKind.commission or e.status not in (EntryStatus.approved, EntryStatus.paid):
        raise HTTPException(409, "Only approved or paid commission entries can be reversed")
    rev = CommissionEntry(kind=EntryKind.reversal, rule_id=None, user_id=e.user_id, application_id=e.application_id,
                          lead_id=e.lead_id, base_amount_minor=e.base_amount_minor, amount_minor=-e.amount_minor,
                          currency=e.currency, status=EntryStatus.approved, reverses_entry_id=e.id,
                          decided_by=p.user_id, decided_at=utcnow(), note=(body.note if body else None))
    db.add(rev)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Entry has already been reversed")
    audit.record(db, p.user_id, "commission.reversed", "commission_entry", e.id, {"reversal_id": str(rev.id)})
    db.commit()
    return rev
