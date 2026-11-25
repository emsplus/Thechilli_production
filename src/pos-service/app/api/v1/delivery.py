"""Endpoints for delivery-service (machine caller) and for staff. docs/DELIVERY_API.md."""
import secrets
import uuid

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.core.tenancy import bind_tenant
from app.models.core import DeliveryOrder, DeliveryOutbox, DeliverySettings, Restaurant
from app.schemas.delivery import DeliveryCancelIn, DeliveryOrderIn, DeliverySettingsIn
from app.services import audit, delivery as svc, delivery_auth, delivery_outbox, public_link

router = APIRouter(prefix="/delivery", tags=["delivery"])


def install(app: FastAPI) -> None:
    """DeliveryError -> {"code","detail","error":{code,message}, **extra}: delivery-service reads the top-level `code`."""
    @app.exception_handler(svc.DeliveryError)
    async def delivery_exc(request: Request, exc: svc.DeliveryError):
        return JSONResponse({"code": exc.code, "detail": exc.message, "error": {"code": exc.code, "message": exc.message},
                             **exc.extra}, status_code=exc.status)


def caller(*scopes: str):
    """Service principal guard. The tenant comes ONLY from the signed token's `rid`; X-Restaurant-ID / restaurant_id, when
    sent, must agree with it (403 otherwise) and are never an authority."""
    def dep(request: Request, authorization: str = Header(default=""), x_restaurant_id: str = Header(default=""),
            db: Session = Depends(get_db)) -> delivery_auth.ServiceCaller:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(401, "Not authenticated")
        try:
            c = delivery_auth.authenticate(token)
            rid = bind_tenant(db, c.restaurant_id)
        except delivery_auth.ServiceAuthError as e:
            raise HTTPException(e.status, str(e))
        except (ValueError, TypeError):
            raise HTTPException(401, "invalid service token")
        if db.get(Restaurant, rid) is None:
            raise HTTPException(401, "invalid service token")
        for claimed in (x_restaurant_id, request.query_params.get("restaurant_id", "")):
            if claimed and claimed != c.restaurant_id:
                raise HTTPException(403, "restaurant does not match the credential")
        if scopes and not set(scopes) <= c.scopes:
            raise HTTPException(403, "credential lacks the required scope")
        return c
    return dep


def _rid(c: delivery_auth.ServiceCaller) -> uuid.UUID:
    return uuid.UUID(c.restaurant_id)


def _get(db: Session, rid: uuid.UUID, order_id: uuid.UUID) -> DeliveryOrder:
    d = db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid, DeliveryOrder.order_id == order_id))
    if d is None:
        raise svc.DeliveryError(404, "not_found", "delivery order not found")
    return d


# ---------------------------------------------------------------------------------------------- service endpoints
@router.get("/menu")
def menu(outlet_id: str = Query(default=""), c=Depends(caller("menu:read")), db: Session = Depends(get_db)):
    rid = _rid(c)
    return svc.menu_payload(db, rid, svc.resolve_outlet(db, rid, outlet_id))


@router.get("/config")
def config(outlet_id: str = Query(default=""), c=Depends(caller("menu:read")), db: Session = Depends(get_db)):
    rid = _rid(c)
    return svc.config_payload(db, rid, svc.resolve_outlet(db, rid, outlet_id))


@router.post("/orders")
def place(data: DeliveryOrderIn, idempotency_key: str = Header(default=""), c=Depends(caller("orders:write")),
          db: Session = Depends(get_db)):
    d, created = svc.place_order(db, _rid(c), idempotency_key, data)
    return JSONResponse(svc.order_payload(d), status_code=201 if created else 200)


@router.get("/orders/{order_id}")
def get_order(order_id: uuid.UUID, c=Depends(caller("orders:read")), db: Session = Depends(get_db)):
    return svc.order_payload(_get(db, _rid(c), order_id))


@router.post("/orders/{order_id}/cancel")
def cancel(order_id: uuid.UUID, data: DeliveryCancelIn | None = None, c=Depends(caller("orders:write")),
           db: Session = Depends(get_db)):
    return svc.order_payload(svc.cancel(db, _rid(c), order_id, (data or DeliveryCancelIn()).reason))


@router.post("/orders/{order_id}/dispatch")
def dispatch(order_id: uuid.UUID, c=Depends(caller("orders:write")), db: Session = Depends(get_db)):
    return svc.order_payload(svc.dispatch(db, _rid(c), order_id))


@router.post("/orders/{order_id}/delivered")
def delivered(order_id: uuid.UUID, c=Depends(caller("orders:write")), db: Session = Depends(get_db)):
    return svc.order_payload(svc.delivered(db, _rid(c), order_id))


# ---------------------------------------------------------------------------------------------- staff endpoints
def _settings_out(cfg: DeliverySettings, public_order_url: str | None = None) -> dict:
    return {"public_order_enabled": bool(cfg.public_order_enabled), "public_order_url": public_order_url,
            "public_order_token_set": bool(cfg.service_token_enc),
            "enabled": bool(cfg.enabled), "accept_before_kot": bool(cfg.accept_before_kot),
            "delivery_fee": str(cfg.delivery_fee), "free_delivery_above": str(cfg.free_delivery_above) if cfg.free_delivery_above is not None else None,
            "min_order": str(cfg.min_order), "radius_km": str(cfg.radius_km) if cfg.radius_km is not None else None,
            "hours": cfg.hours, "webhook_url": cfg.webhook_url, "has_webhook_secret": bool(cfg.webhook_secret)}


@router.get("/settings")
def get_settings(p: Principal = Depends(require_perm(P.DELIVERY_MANAGE)), db: Session = Depends(get_db)):
    cfg = svc.get_settings(db, p.restaurant_id)
    return _settings_out(cfg, public_link.refresh(db, cfg))


@router.put("/settings")
def put_settings(data: DeliverySettingsIn, p: Principal = Depends(require_perm(P.DELIVERY_MANAGE)),
                 db: Session = Depends(get_db)):
    """Partial update. The webhook secret is generated here and returned ONCE (rotate_webhook_secret); it is never readable."""
    cfg = db.get(DeliverySettings, p.restaurant_id)
    if cfg is None:
        cfg = svc.default_settings(db, p.restaurant_id)  # a kitchen's "Take delivery orders" starts on
        db.add(cfg)
    fields = data.model_dump(exclude_unset=True)
    for k in ("enabled", "accept_before_kot", "delivery_fee", "min_order", "radius_km", "hours"):
        if fields.get(k) is not None:
            setattr(cfg, k, fields[k])
    if data.clear_free_delivery_above:
        cfg.free_delivery_above = None
    elif data.free_delivery_above is not None:
        cfg.free_delivery_above = data.free_delivery_above
    if data.webhook_url is not None:
        try:
            cfg.webhook_url = delivery_outbox.validate_webhook_url(data.webhook_url) if data.webhook_url else None
        except ValueError as e:
            raise HTTPException(422, str(e))
    for windows in (data.hours or {}).values():
        for w in windows:
            if len(w) != 2 or any(len(x) != 5 or x[2] != ":" for x in w):
                raise HTTPException(422, "hours windows must be [\"HH:MM\", \"HH:MM\"]")
    out_secret = None
    if data.rotate_webhook_secret or (cfg.webhook_url and not cfg.webhook_secret):
        out_secret = cfg.webhook_secret = secrets.token_urlsafe(32)
    audit.record(db, p, "delivery.settings", "restaurant", p.restaurant_id,
                 {"fields": sorted(k for k in fields if k != "rotate_webhook_secret"), "secret_rotated": out_secret is not None})
    if data.public_order_service_token is not None:
        public_link.set_token(cfg, data.public_order_service_token.get_secret_value().strip())
    db.commit()  # the rest of the settings is saved whatever happens to the link part below

    def result() -> dict:
        out = _settings_out(cfg, cfg.public_order_url if cfg.public_order_enabled else None)
        if out_secret:
            out["webhook_secret"] = out_secret
        return out

    if data.public_order_enabled is not None or data.rotate_public_order_link or data.public_order_brand_color is not None:
        try:
            public_link.apply(db, p, cfg, enable=data.public_order_enabled, rotate=data.rotate_public_order_link,
                              brand_color=data.public_order_brand_color)
        except svc.DeliveryError as e:
            e.extra = {"settings": result()}  # 502 / 409 for the link part; the rest is saved and shown here (webhook secret once)
            raise
    return result()


@router.post("/admin/orders/{order_id}/accept")
def accept(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.DELIVERY_ACCEPT)), db: Session = Depends(get_db)):
    """Accept a `placed` delivery order: sends the KOT and tells delivery-service. Rejecting = the normal order cancel."""
    return svc.order_payload(svc.accept(db, p, order_id, by_order=True))


@router.post("/admin/orders/{order_id}/confirm-payment")
def confirm_payment(order_id: uuid.UUID, p: Principal = Depends(require_perm(P.DELIVERY_ACCEPT)),
                    db: Session = Depends(get_db)):
    return svc.order_payload(svc.confirm_payment(db, p, order_id))


@router.get("/admin/orders")
def list_orders(status: str | None = None, p: Principal = Depends(require_perm(P.DELIVERY_ACCEPT)),
                db: Session = Depends(get_db)):
    q = select(DeliveryOrder).where(DeliveryOrder.restaurant_id == p.restaurant_id)
    if status:
        q = q.where(DeliveryOrder.delivery_status == status)
    return [svc.order_payload(d) for d in db.scalars(q.order_by(DeliveryOrder.created_at.desc()).limit(200))]


@router.get("/admin/outbox")
def outbox(p: Principal = Depends(require_perm(P.DELIVERY_MANAGE)), db: Session = Depends(get_db)):
    counts = dict(db.execute(select(DeliveryOutbox.status, func.count()).where(
        DeliveryOutbox.restaurant_id == p.restaurant_id).group_by(DeliveryOutbox.status)).all())
    dead = db.scalars(select(DeliveryOutbox).where(DeliveryOutbox.restaurant_id == p.restaurant_id,
                                                   DeliveryOutbox.status == "dead").order_by(DeliveryOutbox.created_at).limit(100))
    return {"counts": counts, "dead": [{"id": str(r.id), "event": r.event_type, "order_id": str(r.order_id), "version": r.version,
                                        "attempts": r.attempts, "last_error": r.last_error} for r in dead]}


@router.post("/admin/outbox/{row_id}/retry")
def outbox_retry(row_id: uuid.UUID, p: Principal = Depends(require_perm(P.DELIVERY_MANAGE)), db: Session = Depends(get_db)):
    r = db.get(DeliveryOutbox, row_id)
    if r is None or r.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Event not found")
    if r.status == "dead":
        r.status, r.attempts, r.next_attempt_at = "pending", 0, delivery_outbox.now()
        audit.record(db, p, "delivery.outbox.retry", "delivery_outbox", r.id)
        db.commit()
    return {"id": str(r.id), "status": r.status}
