import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import access
from app.api.deps import ANY_ROLE, SALES, Principal, require_roles
from app.core.db import get_db
from app.core.security import utcnow
from app.models import Demo, DemoStatus, Lead, LeadStage, Role
from app.schemas.api import DemoCreate, DemoOut, DemoUpdate
from app.services import audit

router = APIRouter(tags=["demos"])
PRE_DEMO = (LeadStage.new, LeadStage.contacted, LeadStage.qualified)


def _check_free(db: Session, assignee_id: uuid.UUID, start: datetime, minutes: int, exclude: uuid.UUID | None = None):
    """An assignee cannot hold two overlapping scheduled demos."""
    end = start + timedelta(minutes=minutes)
    others = db.scalars(select(Demo).where(
        Demo.assignee_id == assignee_id, Demo.status == DemoStatus.scheduled,
        Demo.scheduled_at < end, Demo.scheduled_at > start - timedelta(days=1)))
    for d in others:
        if d.id != exclude and d.scheduled_at + timedelta(minutes=d.duration_minutes) > start:
            raise HTTPException(409, "The assignee already has a demo at that time")


def _aware(dt):
    if dt is not None and dt.tzinfo is None:
        raise HTTPException(422, "scheduled_at must include a timezone offset")


@router.post("/leads/{lead_id}/demos", response_model=DemoOut, status_code=201)
def schedule_demo(lead_id: uuid.UUID, body: DemoCreate, p: Principal = Depends(require_roles(*SALES)),
                  db: Session = Depends(get_db)):
    lead = access.get_lead(db, p, lead_id)
    _aware(body.scheduled_at)
    if body.scheduled_at <= utcnow():
        raise HTTPException(422, "scheduled_at must be in the future")
    if lead.stage in (LeadStage.won, LeadStage.lost):
        raise HTTPException(409, f"Cannot schedule a demo for a {lead.stage.value} lead")
    assignee = body.assignee_id or p.user_id
    if assignee != p.user_id and not p.is_admin:
        raise HTTPException(403, "Only an admin can schedule a demo for someone else")
    access.active_user(db, assignee, Role.salesperson, Role.marketing_admin)
    _check_free(db, assignee, body.scheduled_at, body.duration_minutes)
    d = Demo(lead_id=lead.id, assignee_id=assignee, scheduled_at=body.scheduled_at,
             duration_minutes=body.duration_minutes, mode=body.mode, location=body.location, created_by=p.user_id)
    db.add(d)
    db.flush()
    if lead.stage in PRE_DEMO:
        audit.record(db, p.user_id, "lead.stage_changed", "lead", lead.id, {"from": lead.stage.value, "to": "demo_scheduled"})
        lead.stage = LeadStage.demo_scheduled
    audit.record(db, p.user_id, "demo.scheduled", "demo", d.id, {"lead_id": str(lead.id)})
    db.commit()
    return d


@router.get("/demos", response_model=list[DemoOut])
def list_demos(status: DemoStatus | None = None, lead_id: uuid.UUID | None = None, assignee_id: uuid.UUID | None = None,
               start: datetime | None = None, end: datetime | None = None, limit: int = Query(100, ge=1, le=500),
               p: Principal = Depends(require_roles(*ANY_ROLE)), db: Session = Depends(get_db)):
    _aware(start), _aware(end)
    q = select(Demo).join(Lead, Lead.id == Demo.lead_id).where(access.lead_filter(p))
    for col, v in ((Demo.status, status), (Demo.lead_id, lead_id), (Demo.assignee_id, assignee_id)):
        if v is not None:
            q = q.where(col == v)
    if start:
        q = q.where(Demo.scheduled_at >= start)
    if end:
        q = q.where(Demo.scheduled_at < end)
    return list(db.scalars(q.order_by(Demo.scheduled_at, Demo.id).limit(limit)))


@router.patch("/demos/{demo_id}", response_model=DemoOut)
def update_demo(demo_id: uuid.UUID, body: DemoUpdate, p: Principal = Depends(require_roles(*SALES)),
                db: Session = Depends(get_db)):
    d = db.get(Demo, demo_id)
    if not d:
        raise HTTPException(404, "Demo not found")
    lead = access.get_lead(db, p, d.lead_id)
    data = body.model_dump(exclude_unset=True)
    _aware(data.get("scheduled_at"))
    if d.status != DemoStatus.scheduled:
        raise HTTPException(409, f"Demo is {d.status.value} and can no longer be changed")
    if "assignee_id" in data and data["assignee_id"] != d.assignee_id and not p.is_admin:
        raise HTTPException(403, "Only an admin can reassign a demo")
    if data.get("assignee_id"):
        access.active_user(db, data["assignee_id"], Role.salesperson, Role.marketing_admin)
    start = data.get("scheduled_at") or d.scheduled_at
    minutes = data.get("duration_minutes") or d.duration_minutes
    assignee = data.get("assignee_id") or d.assignee_id
    new_status = data.get("status") or DemoStatus.scheduled
    if new_status == DemoStatus.scheduled:
        if {"scheduled_at", "duration_minutes", "assignee_id"} & data.keys():
            if "scheduled_at" in data and start <= utcnow():
                raise HTTPException(422, "scheduled_at must be in the future")
            _check_free(db, assignee, start, minutes, exclude=d.id)
    for k, v in data.items():
        if v is not None:
            setattr(d, k, v)
    if new_status == DemoStatus.completed and lead.stage in PRE_DEMO + (LeadStage.demo_scheduled,):
        audit.record(db, p.user_id, "lead.stage_changed", "lead", lead.id, {"from": lead.stage.value, "to": "demo_done"})
        lead.stage = LeadStage.demo_done
    audit.record(db, p.user_id, "demo.updated", "demo", d.id, {"fields": sorted(data), "status": d.status.value})
    db.commit()
    return d
