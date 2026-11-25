import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_feature, require_perm
from app.core.db import get_db
from app.schemas.cash_sessions import CashCloseIn, CashOpenIn, CashSessionOut
from app.services import cash_sessions as svc

router = APIRouter(tags=["cash-sessions"], dependencies=[Depends(require_feature("cash_drawer"))])


@router.post("/cash-sessions", response_model=CashSessionOut, status_code=201)
def open_session(data: CashOpenIn, response: Response, p: Principal = Depends(require_perm(P.CASHIER_SHIFT)),
                 db: Session = Depends(get_db)):
    """Open the caller's cash session at the request's outlet (one open session per cashier per outlet). 200 on an
    idempotent replay."""
    s, created = svc.open_session(db, p, data)
    if not created:
        response.status_code = 200
    return svc.out(db, s)


@router.get("/cash-sessions/current", response_model=CashSessionOut)
def current_session(p: Principal = Depends(require_perm(P.CASHIER_SHIFT)), db: Session = Depends(get_db)):
    """The caller's open session at this outlet with the live expected cash; 404 when none."""
    return svc.out(db, svc.current(db, p))


@router.get("/cash-sessions", response_model=list[CashSessionOut])
def list_sessions(outlet_id: uuid.UUID | None = None, status: Literal["open", "closed"] | None = None,
                  limit: int = Query(50, ge=1, le=200), p: Principal = Depends(require_perm(P.CASHIER_SHIFT)),
                  db: Session = Depends(get_db)):
    """Own sessions; owners / managers (reports.view) see everyone's."""
    return [svc.out(db, s) for s in svc.listing(db, p, outlet_id, status, limit)]


@router.get("/cash-sessions/{session_id}", response_model=CashSessionOut)
def get_session(session_id: uuid.UUID, p: Principal = Depends(require_perm(P.CASHIER_SHIFT)), db: Session = Depends(get_db)):
    return svc.out(db, svc.get(db, p, session_id))


@router.post("/cash-sessions/{session_id}/close", response_model=CashSessionOut)
def close_session(session_id: uuid.UUID, data: CashCloseIn, p: Principal = Depends(require_perm(P.CASHIER_SHIFT)),
                  db: Session = Depends(get_db)):
    """Close with the counted cash. The server computes expected cash and the variance; a non-zero variance needs
    `variance_reason`. The session's cashier or a manager / owner may close."""
    return svc.out(db, svc.close_session(db, p, session_id, data))
