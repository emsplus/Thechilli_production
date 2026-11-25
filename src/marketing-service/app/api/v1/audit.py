import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import ADMIN, Principal, require_roles
from app.core.db import get_db
from app.models import AuditLog
from app.schemas.api import AuditOut

router = APIRouter(prefix="/audit-log", tags=["audit"])


@router.get("", response_model=list[AuditOut])
def list_audit(entity_type: str | None = None, entity_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
               action: str | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
               p: Principal = Depends(require_roles(*ADMIN)), db: Session = Depends(get_db)):
    q = select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id)
    for col, v in ((AuditLog.entity_type, entity_type), (AuditLog.entity_id, entity_id),
                   (AuditLog.actor_id, actor_id), (AuditLog.action, action)):
        if v is not None:
            q = q.where(col == v)
    return list(db.scalars(q.limit(limit).offset(offset)))
