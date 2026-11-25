"""First-run setup checklist and the restaurant's UPI id (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md)."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.models.core import Restaurant
from app.schemas.frontdesk import SetupStatusOut, UpiIn, UpiOut
from app.services import setup as svc

router = APIRouter(tags=["setup"])
GUARD = require_perm(P.SETUP_MANAGE)


@router.get("/setup/status", response_model=SetupStatusOut)
def setup_status(p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    """Every step with status done (from real data) | skipped | todo, its detail and the API calls that complete it."""
    return svc.status(db, p)


@router.post("/setup/steps/{step_id}/skip", response_model=SetupStatusOut)
def skip_step(step_id: str, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    """Mark a step skipped (idempotent). 404 for an unknown step id."""
    return svc.skip(db, p, step_id)


@router.delete("/setup/steps/{step_id}/skip", response_model=SetupStatusOut)
def unskip_step(step_id: str, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    """Undo a skip (idempotent)."""
    return svc.unskip(db, p, step_id)


@router.get("/restaurant/upi", response_model=UpiOut)  # read: also cashiers (counter payment QR); write stays owner-only
def get_upi(p: Principal = Depends(require_perm(P.SETTINGS_OWNER, P.PAYMENTS_RECORD, P.PAYMENTS_ONLINE)), db: Session = Depends(get_db)):
    return UpiOut(upi_vpa=db.get(Restaurant, p.restaurant_id).upi_vpa)


@router.put("/restaurant/upi", response_model=UpiOut)
def put_upi(data: UpiIn, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. Sets (or with null / "" clears) the UPI id (VPA, name@bank). Audited."""
    return UpiOut(upi_vpa=svc.set_upi(db, p, data.upi_vpa))
