"""Waiter app endpoints (docs/WAITER_API.md): shifts, assigned tables, table status, bill requests."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.api.deps import current_principal, P, Principal, require_perm
from app.core.db import get_db
from app.schemas.waiter import (
    BillRequestOut, ShiftCloseIn, ShiftOpenIn, ShiftOpenOut, ShiftOut, TablesAssignIn, TableStatusOut,
)
from app.services import business_type, outlets, waiter as svc

router = APIRouter(tags=["waiter"])


@router.post("/shifts/open", response_model=ShiftOpenOut)
def open_shift(data: ShiftOpenIn, response: Response, p: Principal = Depends(require_perm(P.SHIFTS_USE)),
               db: Session = Depends(get_db)):
    """Open the caller's shift at the request's outlet (X-Outlet-Id). Idempotent: 201 when created, 200 with `created: false`
    when the user already has an open shift there."""
    s, created = svc.open_shift(db, p, data.note)
    response.status_code = 201 if created else 200
    return ShiftOpenOut(**svc.shift_out(s, svc._names(db, [s.user_id])).model_dump(), created=created)


@router.post("/shifts/close", response_model=ShiftOut)
def close_my_shift(data: ShiftCloseIn | None = None, p: Principal = Depends(require_perm(P.SHIFTS_USE)),
                   db: Session = Depends(get_db)):
    """Close the caller's own open shift at the request's outlet (404 when none is open)."""
    s = svc.close_own_shift(db, p)
    if s is None:
        raise HTTPException(404, "No open shift")
    return svc.shift_out(s, svc._names(db, [s.user_id]))


@router.get("/shifts/current", response_model=ShiftOut | None)
def current_shift(p: Principal = Depends(require_perm(P.SHIFTS_USE)), db: Session = Depends(get_db)):
    """The caller's open shift at the request's outlet, or null."""
    s = svc.current_shift(db, p)
    return svc.shift_out(s, svc._names(db, [s.user_id])) if s else None


@router.get("/shifts/on-shift", response_model=list[ShiftOut])
def on_shift(outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.SHIFTS_MANAGE)),
             db: Session = Depends(get_db)):
    """Who is on shift now (open shifts) in the request's outlet, or `outlet_id`."""
    return svc.list_shifts(db, p, outlet_id, "open")


@router.get("/shifts", response_model=list[ShiftOut])
def list_shifts(status: str | None = None, outlet_id: uuid.UUID | None = None, limit: int = 100,
                p: Principal = Depends(require_perm(P.SHIFTS_MANAGE)), db: Session = Depends(get_db)):
    """Shift history, newest first. `status` = open | closed (default: both); `limit` 1..500."""
    if status not in (None, "open", "closed"):
        raise HTTPException(422, "status must be open or closed")
    return svc.list_shifts(db, p, outlet_id, status, max(1, min(limit, 500)))


@router.post("/shifts/{shift_id}/close", response_model=ShiftOut)
def close_shift(shift_id: uuid.UUID, p: Principal = Depends(require_perm(P.SHIFTS_MANAGE)), db: Session = Depends(get_db)):
    """Manager: close any shift of an accessible outlet. Idempotent on an already closed shift."""
    s = svc.close_shift(db, p, shift_id)
    return svc.shift_out(s, svc._names(db, [s.user_id]))


@router.put("/shifts/{shift_id}/tables", response_model=ShiftOut)
def assign_tables(shift_id: uuid.UUID, data: TablesAssignIn, p: Principal = Depends(require_perm(P.TABLES_ASSIGN)),
                  db: Session = Depends(get_db)):
    """Set the complete list of tables assigned to the user of an OPEN shift ([] clears). Tables must be active tables of the
    shift's outlet. 409 not_available_for_business_type when the business has no tables (clearing with [] always works)."""
    if data.table_ids:
        business_type.require(db, p.restaurant_id, "tables")
    return svc.assign_tables(db, p, shift_id, data.table_ids)


@router.get("/tables/status", response_model=list[TableStatusOut])
def tables_status(outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.ORDERS_CREATE)),
                  db: Session = Depends(get_db)):
    """Live status of every active table of the outlet, derived from the open orders. 409 not_available_for_business_type for
    a business without tables (cloud / hotel kitchen only): the waiter app then skips the table picker."""
    business_type.require(db, p.restaurant_id, "tables")
    return svc.table_status(db, p, outlets.scope(p, outlet_id, all_by_default=False))


@router.get("/tables/my", response_model=list[TableStatusOut])
def my_tables(p: Principal = Depends(require_perm(P.SHIFTS_USE)), db: Session = Depends(get_db)):
    """The tables assigned to the caller's current shift, with live status (409 not_available_for_business_type without tables)."""
    business_type.require(db, p.restaurant_id, "tables")
    return svc.my_tables(db, p)


@router.get("/bill-requests", response_model=list[BillRequestOut])
def bill_requests(outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.BILLS_FINALIZE)),
                  db: Session = Depends(get_db)):
    """The cashier's queue: open orders whose waiter asked for the bill, oldest first."""
    return svc.bill_requests(db, p, outlet_id)
