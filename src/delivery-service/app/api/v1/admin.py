import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import auth as auth_mod
from app.core.db import get_db
from app.core.errors import AppError, Conflict, NotFound
from app.core.security import Caller, read_link_token, require_caller, validate_secret_ref
from app.models import ChannelNumber, DeliveryOrder, Restaurant, Rider
from app.schemas import (
    AssignIn,
    ChannelIn,
    MenuLinkIn,
    OrderOut,
    ReasonIn,
    RestaurantIn,
    RevokeIn,
    RiderIn,
    RiderOut,
    RiderPatch,
)
from app.services import notify, publiclink
from app.services import orders as svc
from app.services.reminders import run_due_reminders

router = APIRouter()
# Every query below filters on caller.restaurant_id, which comes only from the verified token's `tid`.


@router.put("/restaurant")
def put_restaurant(body: RestaurantIn, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    validate_secret_ref(body.pos_webhook_secret_ref)
    validate_secret_ref(body.pos_api_key_ref)
    r = db.get(Restaurant, c.restaurant_id) or Restaurant(restaurant_id=c.restaurant_id)
    for k, v in body.model_dump().items():
        setattr(r, k, v)
    db.add(r)
    db.commit()
    return {"restaurant_id": r.restaurant_id, "brand_name": r.brand_name}


@router.post("/channel-numbers", status_code=201)
def add_channel(body: ChannelIn, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    if not db.get(Restaurant, c.restaurant_id):
        raise NotFound("configure the restaurant first")
    owner = db.scalar(select(func.resolve_channel(body.phone_number_id)))  # RLS hides other tenants' rows
    if owner and owner != c.restaurant_id:
        raise Conflict("phone_number_id is mapped to another restaurant", code="channel_taken")
    if not owner:
        db.add(ChannelNumber(phone_number_id=body.phone_number_id, restaurant_id=c.restaurant_id,
                             display_number=body.display_number))
        db.commit()
    return {"phone_number_id": body.phone_number_id}


@router.post("/riders", status_code=201, response_model=RiderOut)
def add_rider(body: RiderIn, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    if db.scalar(select(Rider).where(Rider.restaurant_id == c.restaurant_id, Rider.phone == body.phone,
                                     Rider.role == body.role)):
        raise Conflict("already exists", code="duplicate")
    r = Rider(restaurant_id=c.restaurant_id, **body.model_dump())
    db.add(r)
    db.commit()
    return r


@router.get("/riders", response_model=list[RiderOut])
def list_riders(c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    return db.scalars(select(Rider).where(Rider.restaurant_id == c.restaurant_id).order_by(Rider.created_at)).all()


@router.patch("/riders/{rider_id}", response_model=RiderOut)
def patch_rider(rider_id: uuid.UUID, body: RiderPatch, c: Caller = Depends(require_caller),
                db: Session = Depends(get_db)):
    r = db.scalar(select(Rider).where(Rider.id == rider_id, Rider.restaurant_id == c.restaurant_id))
    if not r:
        raise NotFound("rider not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(r, k, v)
    db.commit()
    return r


@router.get("/orders", response_model=list[OrderOut])
def list_orders(status: str | None = None, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    q = select(DeliveryOrder).where(DeliveryOrder.restaurant_id == c.restaurant_id)
    if status:
        q = q.where(DeliveryOrder.status == status)
    return db.scalars(q.order_by(DeliveryOrder.created_at.desc()).limit(200)).all()


@router.get("/orders/{order_id}", response_model=OrderOut)
def read_order(order_id: uuid.UUID, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    return svc.get_order(db, c.restaurant_id, order_id)


@router.post("/orders/{order_id}/assign", response_model=OrderOut)
def assign(order_id: uuid.UUID, body: AssignIn, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    o = svc.get_order(db, c.restaurant_id, order_id)
    if body.rider_id:
        r = db.scalar(select(Rider).where(Rider.id == body.rider_id, Rider.restaurant_id == c.restaurant_id))
        if not r:
            raise NotFound("rider not found")
        svc.offer(db, o, r)
    else:
        svc.auto_assign(db, o)
    db.commit()
    notify.flush_all(db)
    return o


@router.post("/orders/{order_id}/otp/reset", response_model=OrderOut)
def otp_reset(order_id: uuid.UUID, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    o = svc.get_order(db, c.restaurant_id, order_id)
    svc.reset_otp(db, o)
    db.commit()
    notify.flush_all(db)
    return o


@router.post("/orders/{order_id}/override-deliver", response_model=OrderOut)
def override(order_id: uuid.UUID, body: ReasonIn, c: Caller = Depends(require_caller),
             db: Session = Depends(get_db)):
    o = svc.get_order(db, c.restaurant_id, order_id)
    svc.manager_override_deliver(db, o, body.reason)
    notify.flush_all(db)
    return o


@router.post("/orders/{order_id}/cancel", response_model=OrderOut)
def cancel(order_id: uuid.UUID, body: ReasonIn, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    o = svc.get_order(db, c.restaurant_id, order_id)
    svc.cancel_order(db, o, body.reason)
    notify.flush_all(db)
    return o


@router.post("/tokens/revoke")
def revoke_token(body: RevokeIn, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    """Revoke one signed token (menu/track/rider link or a service token) of THIS tenant by its jti. Rotating the keyring
    (docs/DESIGN.md) revokes everything a retired key signed."""
    claims = read_link_token(body.token, body.aud)
    if str(claims.get("tid") or claims.get("rid") or "") != c.restaurant_id:
        raise NotFound("token not found")  # never confirm another tenant's token
    if not auth_mod.revoke(db, c.restaurant_id, claims, body.reason):
        raise AppError("token has no id (legacy); rotate the signing key instead", code="not_revocable", status=422)
    auth_mod.purge_expired(db, c.restaurant_id)
    db.commit()
    return {"revoked": True}


@router.post("/menu-links")
def menu_link(body: MenuLinkIn, c: Caller = Depends(require_caller)):
    return {"url": svc.menu_link(c.restaurant_id, body.wa_number)}


@router.post("/internal/jobs/run")
def run_jobs(c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    """Cron entry point for this tenant's queues (reminders, outbox to Chilli Agent, outbound messages)."""
    return {"reminders": run_due_reminders(db, restaurant_id=c.restaurant_id),
            "outbox": notify.flush_outbox(db, restaurant_id=c.restaurant_id),
            "messages": notify.flush_outbound(db, restaurant_id=c.restaurant_id),
            "public_buckets_purged": publiclink.purge_stale_buckets(db, c.restaurant_id)}
