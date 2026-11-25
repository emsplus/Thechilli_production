"""Table reservations (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md). Every route needs reservations.manage and works in the
request's outlet (X-Outlet-Id, default outlet)."""
import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.schemas.common import WhatsAppOutboxOut
from app.schemas.frontdesk import (
    AvailabilityOut, ReservationCancelIn, ReservationIn, ReservationOut, ReservationPatch, ReservationRemindIn,
    ReservationRemindOut, ReservationSeatIn, ReservationStatus,
)
from app.services import business_type, orders as orders_svc, reservations as svc

router = APIRouter(tags=["reservations"])
_PERM = require_perm(P.RESERVATIONS_MANAGE)


def GUARD(p: Principal = Depends(_PERM), db: Session = Depends(get_db)) -> Principal:
    """reservations.manage, and the business must run a restaurant (409 not_available_for_business_type otherwise; existing
    reservations are hidden, not deleted, while Restaurant is not selected)."""
    business_type.require(db, p.restaurant_id, "reservations")
    return p



@router.get("/reservations", response_model=list[ReservationOut])
def list_reservations(date_: date | None = Query(default=None, alias="date"), status: ReservationStatus | None = None,
                      outlet_id: uuid.UUID | None = None, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    """The reservations of one outlet-local day (default today), earliest first."""
    rows = svc.listing(db, p, date_, status, outlet_id)
    labels = svc.table_labels(db, rows)
    return [svc.out(db, r, labels) for r in rows]


@router.get("/reservations/availability", response_model=AvailabilityOut)
def availability(starts_at: datetime, party_size: int = Query(ge=1, le=500), duration_minutes: int = Query(default=90, ge=15, le=720),
                 exclude_reservation_id: uuid.UUID | None = None, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    """Every active table of the outlet for the slot: `fits` (seats), `available` (no overlapping booked / seated
    reservation, and not occupied by an open order when the slot is now), the overlapping reservation ids."""
    return svc.availability(db, p, starts_at, party_size, duration_minutes, exclude_reservation_id)


@router.post("/reservations", response_model=ReservationOut, status_code=201)
def create_reservation(data: ReservationIn, response: Response, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    """Book. 409 `table_already_reserved` when the table is held for an overlapping time. 200 on a client_uuid replay."""
    r, created = svc.create(db, p, data)
    if not created:
        response.status_code = 200
    return svc.out(db, r)


@router.get("/reservations/{reservation_id}", response_model=ReservationOut)
def get_reservation(reservation_id: uuid.UUID, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    return svc.out(db, svc.load(db, p, reservation_id))


@router.patch("/reservations/{reservation_id}", response_model=ReservationOut)
def update_reservation(reservation_id: uuid.UUID, data: ReservationPatch, p: Principal = Depends(GUARD),
                       db: Session = Depends(get_db)):
    """Change a booked reservation (only the fields sent). The table hold is re-checked (409 table_already_reserved)."""
    return svc.out(db, svc.update(db, p, reservation_id, data))


@router.post("/reservations/{reservation_id}/seat", response_model=ReservationOut)
def seat_reservation(reservation_id: uuid.UUID, data: ReservationSeatIn, p: Principal = Depends(GUARD),
                     db: Session = Depends(get_db)):
    """Seat the guests: attaches the table's open order, else creates one (with `lines`, or empty). Idempotent."""
    try:
        return svc.out(db, svc.seat(db, p, reservation_id, data))
    except orders_svc.PriceConflict as c:
        from app.api.v1.orders import _price_changed
        raise _price_changed(c)


@router.post("/reservations/{reservation_id}/cancel", response_model=ReservationOut)
def cancel_reservation(reservation_id: uuid.UUID, data: ReservationCancelIn, p: Principal = Depends(GUARD),
                       db: Session = Depends(get_db)):
    return svc.out(db, svc.cancel(db, p, reservation_id, data.reason))


@router.post("/reservations/{reservation_id}/no-show", response_model=ReservationOut)
def no_show(reservation_id: uuid.UUID, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    return svc.out(db, svc.no_show(db, p, reservation_id))


@router.post("/reservations/{reservation_id}/remind", response_model=ReservationRemindOut, status_code=202)
def remind(reservation_id: uuid.UUID, data: ReservationRemindIn, p: Principal = Depends(GUARD), db: Session = Depends(get_db)):
    """Queue an English WhatsApp reminder (template pos_reservation_reminder_v1). 409 whatsapp_disabled when the restaurant
    has WhatsApp off, 409 sms_unavailable for channel sms, 422 without a valid mobile number."""
    r, row = svc.remind(db, p, reservation_id, data.channel)
    return ReservationRemindOut(reservation=svc.out(db, r), outbox=WhatsAppOutboxOut.model_validate(row))
