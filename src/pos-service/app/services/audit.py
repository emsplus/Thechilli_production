import base64
import uuid
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.models.core import AuditLog, User


def record(db: Session, p, action: str, entity: str, entity_id=None, detail=None) -> None:
    support = getattr(p, "support", None)  # platform support staff are not tenant users: no FK, the claims go in the detail
    if support:
        detail = {**(detail or {}), "support": {"staff_id": support["sub"], "grant_id": support["grant_id"]}}
    db.add(AuditLog(
        restaurant_id=p.restaurant_id, user_id=None if support else p.user_id, action=action,
        entity=entity, entity_id=str(entity_id) if entity_id else None, detail=detail,
    ))


def _encode_cursor(created_at, row_id) -> str:
    return base64.urlsafe_b64encode(f"{created_at.isoformat()}|{row_id}".encode()).decode()


def _decode_cursor(cursor: str):
    try:
        ts, rid = base64.urlsafe_b64decode(cursor.encode()).decode().split("|")
        return datetime.fromisoformat(ts), uuid.UUID(rid)
    except Exception:
        raise HTTPException(422, "Invalid cursor")


def search(db: Session, restaurant_id: uuid.UUID, *, action: str | None = None, entity: str | None = None,
           user_id: uuid.UUID | None = None, from_date: date | None = None, to_date: date | None = None,
           limit: int = 50, cursor: str | None = None) -> dict:
    """Newest first, keyset-paginated on (created_at, id). Dates are restaurant-local (reports.Ctx.window)."""
    from app.services.reports import Ctx  # local import: reports pulls in most of the model layer
    c = Ctx(db, restaurant_id)
    q = (select(AuditLog, User.email, User.full_name).join(User, User.id == AuditLog.user_id, isouter=True)
         .where(AuditLog.restaurant_id == restaurant_id))
    if from_date and to_date and to_date < from_date:
        raise HTTPException(422, "to_date is before from_date")
    if from_date:
        q = q.where(AuditLog.created_at >= c.window(from_date, from_date)[0])
    if to_date:
        q = q.where(AuditLog.created_at < c.window(to_date, to_date)[1])
    if action:
        q = q.where(AuditLog.action.startswith(action, autoescape=True))
    if entity:
        q = q.where(AuditLog.entity == entity)
    if user_id:
        q = q.where(AuditLog.user_id == user_id)
    if cursor:
        ts, rid = _decode_cursor(cursor)
        q = q.where(tuple_(AuditLog.created_at, AuditLog.id) < tuple_(ts, rid))
    rows = db.execute(q.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit + 1)).all()
    page, more = rows[:limit], len(rows) > limit
    items = [{"id": a.id, "created_at": a.created_at, "action": a.action, "entity": a.entity,
              "entity_id": a.entity_id, "detail": a.detail, "user_id": a.user_id,
              "user_email": email, "user_name": name} for a, email, name in page]
    return {"items": items, "next_cursor": _encode_cursor(page[-1][0].created_at, page[-1][0].id) if more else None}
