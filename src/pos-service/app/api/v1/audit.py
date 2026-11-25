import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.services import audit

router = APIRouter(tags=["audit"])


@router.get("/audit-logs")
def audit_logs(action: str | None = Query(None, max_length=100, description="action prefix, e.g. 'bill.'"),
               entity: str | None = Query(None, max_length=100), user_id: uuid.UUID | None = None,
               from_date: date | None = None, to_date: date | None = None,
               limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
               p: Principal = Depends(require_perm(P.AUDIT_VIEW)), db: Session = Depends(get_db)):
    return audit.search(db, p.restaurant_id, action=action, entity=entity, user_id=user_id,
                        from_date=from_date, to_date=to_date, limit=limit, cursor=cursor)
