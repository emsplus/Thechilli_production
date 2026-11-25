import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api import access
from app.api.deps import ANY_ROLE, Principal, require_roles
from app.core.db import get_db
from app.core.security import utcnow
from app.models import Activity, Lead
from app.schemas.api import ActivityCreate, ActivityOut
from app.services import audit

router = APIRouter(tags=["activities"])


def _aware(dt: datetime | None, field: str) -> None:
    if dt is not None and dt.tzinfo is None:
        raise HTTPException(422, f"{field} must include a timezone offset")


@router.post("/leads/{lead_id}/activities", response_model=ActivityOut, status_code=201)
def create_activity(lead_id: uuid.UUID, body: ActivityCreate, p: Principal = Depends(require_roles(*ANY_ROLE)),
                    db: Session = Depends(get_db)):
    lead = access.get_lead(db, p, lead_id)
    _aware(body.due_at, "due_at")
    if body.assignee_id:
        access.active_user(db, body.assignee_id)
    a = Activity(lead_id=lead.id, type=body.type, summary=body.summary, due_at=body.due_at,
                 assignee_id=body.assignee_id or p.user_id, created_by=p.user_id,
                 completed_at=utcnow() if body.completed else None)
    db.add(a)
    db.flush()
    audit.record(db, p.user_id, "activity.created", "activity", a.id, {"lead_id": str(lead.id), "type": a.type.value})
    db.commit()
    return a


@router.get("/leads/{lead_id}/activities", response_model=list[ActivityOut])
def lead_activities(lead_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    lead = access.get_lead(db, p, lead_id)
    return list(db.scalars(select(Activity).where(Activity.lead_id == lead.id).order_by(Activity.created_at.desc(), Activity.id)))


@router.get("/activities", response_model=list[ActivityOut])
def list_follow_ups(status: str = Query("pending", pattern="^(pending|overdue|completed|all)$"),
                    due_before: datetime | None = None, mine: bool = True, limit: int = Query(100, ge=1, le=500),
                    p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    """The follow-up queue. Non-admins always see only their own; admins can pass mine=false."""
    _aware(due_before, "due_before")
    q = select(Activity).join(Lead, Lead.id == Activity.lead_id).where(access.lead_filter(p))
    if mine or not p.is_admin:
        q = q.where(or_(Activity.assignee_id == p.user_id, Activity.created_by == p.user_id))
    if status == "pending":
        q = q.where(Activity.completed_at.is_(None), Activity.due_at.is_not(None))
    elif status == "overdue":
        q = q.where(Activity.completed_at.is_(None), Activity.due_at < utcnow())
    elif status == "completed":
        q = q.where(Activity.completed_at.is_not(None))
    if due_before:
        q = q.where(Activity.due_at <= due_before)
    return list(db.scalars(q.order_by(Activity.due_at.asc().nulls_last(), Activity.id).limit(limit)))


@router.post("/activities/{activity_id}/complete", response_model=ActivityOut)
def complete_activity(activity_id: uuid.UUID, p: Principal = Depends(require_roles(*ANY_ROLE)),
                      db: Session = Depends(get_db)):
    a = db.get(Activity, activity_id)
    if not a:
        raise HTTPException(404, "Activity not found")
    access.get_lead(db, p, a.lead_id)  # 404 when the lead is not visible
    if a.completed_at is not None:
        raise HTTPException(409, "Activity is already completed")
    a.completed_at = utcnow()
    audit.record(db, p.user_id, "activity.completed", "activity", a.id, {"lead_id": str(a.lead_id)})
    db.commit()
    return a
