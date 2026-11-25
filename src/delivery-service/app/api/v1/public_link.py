"""Public restaurant ordering link (docs/PUBLIC_ORDER_LINK.md).

Owner side (`/restaurants/{id}/public-link`, Bearer tenant token like every admin call; `{id}` must be the token's tenant): ensure,
read, rotate, disable, enable, brand colour, QR as SVG. Visitor side (`/public/r/{slug}`): the live menu and ordering for an anonymous
customer identified by name + phone, behind per-IP / per-phone / per-link rate limits."""
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.errors import AppError, Conflict, NotFound
from app.core.security import Caller, keyed_hash, require_caller
from app.models import TERMINAL, DeliveryOrder, PublicLink, Restaurant
from app.pos.base import PosUnavailable
from app.schemas import PublicLinkIn, PublicLinkPatch, PublicOrderIn
from app.services import notify
from app.services import orders as svc
from app.services import publiclink as pl

admin = APIRouter(prefix="/restaurants/{restaurant_id}/public-link")
public = APIRouter(prefix="/public/r")
NO_STORE = {"Cache-Control": "no-store"}


# ---------------------------------------------------------------------------------------------- owner side
def _own(restaurant_id: str, c: Caller) -> str:
    if restaurant_id != c.restaurant_id:
        raise NotFound("restaurant not found")  # never confirm that another tenant exists
    return restaurant_id


def _out(link: PublicLink) -> dict:
    return {"restaurant_id": link.restaurant_id, "enabled": link.enabled, "slug": link.slug, "url": pl.public_url(link.slug),
            "qr_svg_path": f"/api/v1/restaurants/{link.restaurant_id}/public-link/qr.svg", "brand_color": link.brand_color,
            "created_at": link.created_at, "rotated_at": link.rotated_at, "disabled_at": link.disabled_at}


def _existing(db: Session, rid: str) -> PublicLink:
    link = pl.get_link(db, rid)
    if not link:
        raise NotFound("no public link yet: POST to create it", code="no_public_link")
    return link


@admin.post("")
def ensure_link(restaurant_id: str, response: Response, body: PublicLinkIn | None = None, c: Caller = Depends(require_caller),
                db: Session = Depends(get_db)):
    """Idempotent. Creates the link (201) or returns the existing one unchanged (200), enabled or not."""
    rid = _own(restaurant_id, c)
    if not db.get(Restaurant, rid):
        raise NotFound("configure the restaurant first")
    link, created = pl.ensure_link(db, rid, pl.valid_color(body.brand_color if body else None))
    db.commit()
    response.status_code = 201 if created else 200
    return _out(link)


@admin.get("")
def read_link(restaurant_id: str, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    return _out(_existing(db, _own(restaurant_id, c)))


@admin.patch("")
def patch_link(restaurant_id: str, body: PublicLinkPatch, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    link = _existing(db, _own(restaurant_id, c))
    fields = body.model_dump(exclude_unset=True)
    if "brand_color" in fields:
        link.brand_color = pl.valid_color(fields["brand_color"])
    if fields.get("enabled") is not None:
        pl.set_enabled(link, fields["enabled"])
    db.commit()
    return _out(link)


@admin.post("/rotate")
def rotate_link(restaurant_id: str, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    """New slug, old URL dead at once (404). A disabled link stays disabled."""
    link = pl.rotate(db, _existing(db, _own(restaurant_id, c)))
    db.commit()
    return _out(link)


@admin.post("/disable")
def disable_link(restaurant_id: str, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    link = pl.set_enabled(_existing(db, _own(restaurant_id, c)), False)
    db.commit()
    return _out(link)


@admin.post("/enable")
def enable_link(restaurant_id: str, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    link = pl.set_enabled(_existing(db, _own(restaurant_id, c)), True)
    db.commit()
    return _out(link)


@admin.get("/qr.svg")
def qr(restaurant_id: str, c: Caller = Depends(require_caller), db: Session = Depends(get_db)):
    link = _existing(db, _own(restaurant_id, c))
    if not link.enabled:
        raise Conflict("the link is disabled", code="link_disabled")
    return Response(pl.qr_svg(pl.public_url(link.slug)), media_type="image/svg+xml",
                    headers={**NO_STORE, "Content-Disposition": 'inline; filename="order-link-qr.svg"',
                             "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'none'"})


# ---------------------------------------------------------------------------------------------- visitor side
def _menu_and_config(db: Session, rid: str) -> tuple[dict, dict]:
    try:
        return svc.cached_menu(db, rid), svc.cached_config(db, rid)
    except PosUnavailable:
        raise AppError("ordering is temporarily unavailable", code="pos_unavailable", status=503) from None


@public.get("/{slug}")
def public_menu(slug: str, request: Request, response: Response, db: Session = Depends(get_db)):
    rid = pl.resolve_or_404(db, request, slug)
    pl.throttle(db, rid, f"pg:{keyed_hash('ip', pl.client_ip(request))}", settings.public_get_ip_capacity,
                settings.public_get_ip_refill_per_second)
    menu, cfg = _menu_and_config(db, rid)
    rest, link = db.get(Restaurant, rid), pl.get_link(db, rid)
    av = pl.availability(cfg)
    response.headers.update({**NO_STORE, "X-Robots-Tag": "noindex, nofollow, noarchive"})
    items = [{**i, "sold_out": not i.get("is_active", True)} for i in menu.get("items", [])]
    items.sort(key=lambda i: i.get("sort_order", 0))
    return {"mode": "public", "brand": rest.brand_name if rest else "", "prefill": {}, "menu_version": menu.get("menu_version"),
            "categories": menu.get("categories", []), "items": items,
            "payment_qr_url": rest.payment_qr_url if rest else None,
            "open": av["open"], "closed_reason": av["reason"], "next_open": av["next_open"],
            "min_order": int(cfg.get("min_order") or 0), "theme": pl.theme(link.brand_color if link else None)}


def _order_out(o: DeliveryOrder) -> dict:
    return {"order_id": str(o.id), "order_code": o.order_code, "subtotal": o.subtotal, "delivery_fee": o.delivery_fee,
            "tax": o.tax, "total": o.total, "status": o.status, "track_url": svc.track_link(o)}


@public.post("/{slug}/order", status_code=201)
def public_order(slug: str, body: PublicOrderIn, request: Request, response: Response, db: Session = Depends(get_db)):
    rid = pl.resolve_or_404(db, request, slug)
    response.headers.update(NO_STORE)
    pl.throttle(db, rid, f"pi:{keyed_hash('ip', pl.client_ip(request))}", settings.public_order_ip_capacity,
                settings.public_order_ip_refill_per_second)
    pl.throttle(db, rid, "pl", settings.public_order_link_capacity, settings.public_order_link_refill_per_second)
    phone = pl.valid_phone(body.phone)
    if not phone:
        raise AppError("enter a valid mobile number", code="invalid_phone", status=422)
    pl.throttle(db, rid, f"pp:{keyed_hash('ph', phone)}", settings.public_order_phone_capacity,
                settings.public_order_phone_refill_per_second)

    # Replay of the same key by the same phone returns the original order; the same key from another phone is refused (never leaks it).
    prior = db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid, DeliveryOrder.client_uuid == body.client_uuid))
    if prior is not None:
        if prior.wa_number != phone:
            raise AppError("idempotency key reused with a different order", code="idempotency_conflict", status=422)
        return _order_out(prior)

    menu, cfg = _menu_and_config(db, rid)
    av = pl.availability(cfg)
    if not av["open"]:
        raise AppError("the restaurant is not taking orders right now", code="restaurant_closed", status=409,
                       extra={"reason": av["reason"], "next_open": av["next_open"]})
    items = {i["id"]: i for i in menu.get("items", [])}
    subtotal = 0
    for ln in body.lines:  # sold-out lines are rejected with the same code POS uses; the minimum is checked on our snapshot first
        it = items.get(ln.item_id)
        if not it or not it.get("is_active", True):
            raise AppError(f"item {ln.item_id} is not available", code="item_unavailable", status=422)
        subtotal += svc.line_price(it, ln.variant_id) * ln.quantity
    min_order = int(cfg.get("min_order") or 0)
    if subtotal < min_order:
        raise AppError("the order is below the minimum order amount", code="below_min_order", status=422,
                       extra={"min_order": min_order})
    open_orders = db.scalar(select(func.count()).select_from(DeliveryOrder).where(
        DeliveryOrder.restaurant_id == rid, DeliveryOrder.wa_number == phone, DeliveryOrder.status.notin_(TERMINAL)))
    if open_orders >= settings.public_max_open_orders_per_phone:
        raise AppError("this number already has orders on the way", code="too_many_open_orders", status=429)

    o = svc.place_order(db, rid, client_uuid=body.client_uuid, channel="web", name=body.name.strip(), wa_number=phone,
                        address=body.address.model_dump(), payment_mode=body.payment_mode, claimed_paid=body.claimed_paid,
                        lines=[ln.model_dump() for ln in body.lines], promo_code=body.promo_code)
    notify.flush_all(db)
    return _order_out(o)
