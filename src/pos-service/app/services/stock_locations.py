"""Stock locations (docs/INVENTORY.md): places inside an outlet where stock is kept. Every outlet has one default location."""
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import Outlet
from app.models.inventory import StockLocation
from app.services import audit

DEFAULT_NAME = "Main store"


def ensure_default(db: Session, restaurant_id: uuid.UUID, outlet_id: uuid.UUID | None = None) -> StockLocation:
    """The default location of an outlet, created if missing. Concurrency-safe (partial unique index + ON CONFLICT)."""
    if outlet_id is None:
        from app.services import outlets
        outlet_id = outlets.default_outlet(db, restaurant_id).id
    q = select(StockLocation).where(StockLocation.outlet_id == outlet_id, StockLocation.restaurant_id == restaurant_id,
                                    StockLocation.is_default)
    loc = db.scalar(q)
    if loc is None:
        db.execute(pg_insert(StockLocation).values(
            id=uuid.uuid4(), restaurant_id=restaurant_id, outlet_id=outlet_id, name=DEFAULT_NAME, kind="store", is_default=True,
            is_active=True).on_conflict_do_nothing())
        loc = db.scalar(q.execution_options(populate_existing=True))
    if loc is None:
        raise HTTPException(500, "Outlet has no stock location")
    return loc


def get(db: Session, p, location_id: uuid.UUID, *, outlet_only: bool = True) -> StockLocation:
    """A location of this tenant (and, by default, of the request's outlet); 404 otherwise."""
    loc = db.get(StockLocation, location_id)
    if loc is None or loc.restaurant_id != p.restaurant_id or (
            outlet_only and p.outlet_id is not None and loc.outlet_id != p.outlet_id):
        raise HTTPException(404, "Stock location not found")
    return loc


def resolve(db: Session, p, location_id: uuid.UUID | None) -> StockLocation:
    """The location a document works in: the given one (must be in the request's outlet) or the outlet's default."""
    if location_id is not None:
        loc = get(db, p, location_id)
        if not loc.is_active:
            raise HTTPException(409, "Stock location is archived")
        return loc
    from app.services import outlets
    return ensure_default(db, p.restaurant_id, outlets.outlet_of(db, p))


def list_for(db: Session, p, include_inactive: bool = False) -> list[StockLocation]:
    from app.services import outlets
    ensure_default(db, p.restaurant_id, outlets.outlet_of(db, p))
    q = select(StockLocation).where(StockLocation.restaurant_id == p.restaurant_id, StockLocation.outlet_id == outlets.outlet_of(db, p))
    if not include_inactive:
        q = q.where(StockLocation.is_active)
    return list(db.scalars(q.order_by(StockLocation.is_default.desc(), StockLocation.name)))


def create(db: Session, p, name: str, kind: str) -> StockLocation:
    from app.services import outlets
    loc = StockLocation(restaurant_id=p.restaurant_id, outlet_id=outlets.outlet_of(db, p), name=name.strip(), kind=kind)
    ensure_default(db, p.restaurant_id, loc.outlet_id)
    db.add(loc)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A stock location with this name already exists in this outlet")
    audit.record(db, p, "stock_location.create", "stock_location", loc.id, {"name": loc.name})
    db.commit()
    return loc


def update(db: Session, p, location_id: uuid.UUID, name: str | None, kind: str | None, is_active: bool | None) -> StockLocation:
    loc = get(db, p, location_id)
    if is_active is False and loc.is_default:
        raise HTTPException(409, "The default location cannot be archived")
    if name is not None:
        loc.name = name.strip()
    if kind is not None:
        loc.kind = kind
    if is_active is not None:
        loc.is_active = is_active
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A stock location with this name already exists in this outlet")
    audit.record(db, p, "stock_location.update", "stock_location", loc.id, {"name": loc.name, "is_active": loc.is_active})
    db.commit()
    return loc
