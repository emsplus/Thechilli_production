"""Outlets (docs/OUTLETS.md): physical locations of one tenant. Every restaurant has exactly one default outlet, created at
registration (and by the migration for existing tenants). The location-level settings are copied from the restaurant; the
restaurant keeps its own copy until Phase 2, so writers update both (`sync_default`)."""
import uuid
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import Outlet, Restaurant, Role, UserOutletAccess
from app.services import audit

# Restaurant columns mirrored onto the default outlet (docs/PHASE1_PLAN.md "Model").
MIRRORED = ("address", "phone", "trn", "currency", "timezone", "country", "prices_include_tax", "vat_registered",
            "service_charge_percent", "max_cashier_discount_percent", "z_report_next_number",
            "auto_reorder_emails", "reorder_email_window_hours")
DEFAULT_CODE = "MAIN"


def create_default(db: Session, r: Restaurant) -> Outlet:
    o = Outlet(id=uuid.uuid4(), restaurant_id=r.id, name=r.name, code=DEFAULT_CODE, invoice_prefix="", is_default=True,
               **{k: getattr(r, k) for k in MIRRORED})
    db.add(o)
    db.flush()
    _default_location(db, o)
    return o


def _default_location(db: Session, o: Outlet) -> None:
    from app.services import stock_locations  # local import: stock_locations imports this module lazily
    stock_locations.ensure_default(db, o.restaurant_id, o.id)


def default_outlet(db: Session, restaurant_id: uuid.UUID) -> Outlet:
    o = db.scalar(select(Outlet).where(Outlet.restaurant_id == restaurant_id, Outlet.is_default))
    if o is None:  # the migration / registration guarantee one; never invent an id
        raise HTTPException(500, "Restaurant has no default outlet")
    return o


def outlet_of(db: Session, p) -> uuid.UUID:
    """The outlet id new rows of this request belong to: the principal's outlet, else the tenant's default outlet (background
    jobs and tests build principals without one)."""
    oid = getattr(p, "outlet_id", None)
    return oid if oid is not None else default_outlet(db, p.restaurant_id).id


def seller_details(db: Session, restaurant: Restaurant, outlet_id: uuid.UUID) -> dict:
    """Seller tax number / address / phone printed on an invoice. The default outlet prints the restaurant's own values
    (identical to before outlets existed); another outlet prints its own address and phone, and its tax number if it has one."""
    o = db.get(Outlet, outlet_id)
    if o is None or o.is_default:
        return {"seller_trn": restaurant.trn, "seller_address": restaurant.address, "seller_phone": restaurant.phone}
    return {"seller_trn": o.trn or restaurant.trn, "seller_address": o.address, "seller_phone": o.phone}


def sync_default(db: Session, r: Restaurant) -> None:
    """Copies the restaurant's mirrored settings (and name) to its default outlet. Call after changing them. Flushes."""
    db.flush()
    o = default_outlet(db, r.id)
    o.name = r.name
    for k in MIRRORED:
        setattr(o, k, getattr(r, k))
    db.flush()


def list_outlets(db: Session, restaurant_id: uuid.UUID, include_inactive: bool = True) -> list[Outlet]:
    q = select(Outlet).where(Outlet.restaurant_id == restaurant_id)
    if not include_inactive:
        q = q.where(Outlet.is_active)
    return list(db.scalars(q.order_by(Outlet.is_default.desc(), Outlet.created_at, Outlet.code)))


def get(db: Session, restaurant_id: uuid.UUID, outlet_id: uuid.UUID, *, lock: bool = False) -> Outlet:
    q = select(Outlet).where(Outlet.id == outlet_id, Outlet.restaurant_id == restaurant_id)
    o = db.scalar(q.with_for_update() if lock else q)
    if o is None:
        raise HTTPException(404, "Outlet not found")
    return o


def _tz(name: str) -> str:
    try:
        ZoneInfo(name)
    except Exception:
        raise HTTPException(422, "Unknown timezone")
    return name


def check_outlet_limit(db: Session, restaurant_id: uuid.UUID) -> None:
    """Entitlements: refuse to add one more ACTIVE outlet beyond platform-core's outlet_limit (None = unlimited, 0 = none).
    ENTITLEMENTS_ENFORCE=on refuses (403 outlet_limit_reached); warn logs; off does nothing. Call with the tenant row locked."""
    from app.services import entitlements  # local: entitlements imports nothing from here, but keeps this module light
    e = entitlements.current(restaurant_id)
    if e is None or e.outlet_limit is None or e.suspended:  # a suspended tenant is stopped by the read-only rule
        return
    active = db.scalar(select(func.count()).select_from(Outlet).where(Outlet.restaurant_id == restaurant_id, Outlet.is_active))
    if active >= e.outlet_limit:
        if entitlements.mode() == "on":
            raise entitlements.EntitlementError(403, "outlet_limit_reached",
                                                f"Your plan allows {e.outlet_limit} outlet(s); upgrade to add more")
        entitlements.log.warning("entitlements(warn): tenant %s is at its outlet limit (%s)", restaurant_id, e.outlet_limit)


def create(db: Session, p, data) -> Outlet:
    """A second+ outlet inherits country (IN), currency (INR) and the tax settings of the restaurant (tax rules are tenant-level in
    Phase 1). Its code and invoice prefix are fixed at creation: numbering must never change identity afterwards."""
    r = db.get(Restaurant, p.restaurant_id, with_for_update=True)  # serializes concurrent creates of one tenant
    if len(data.invoice_prefix) > 4:  # GST Rule 46: invoice numbers are at most 16 characters
        raise HTTPException(422, "Invoice prefix can be at most 4 characters for an Indian restaurant (GST invoice numbers "
                                 "are limited to 16 characters)")
    check_outlet_limit(db, r.id)
    o = Outlet(id=uuid.uuid4(), restaurant_id=r.id, name=data.name, code=data.code, invoice_prefix=data.invoice_prefix,
               is_default=False, **{k: getattr(r, k) for k in MIRRORED})
    o.z_report_next_number = 1
    for k in ("address", "phone", "trn"):
        if k in data.model_fields_set:
            setattr(o, k, getattr(data, k))
    if data.timezone:
        o.timezone = _tz(data.timezone)
    db.add(o)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Outlet code or invoice prefix already used in this restaurant")
    _default_location(db, o)
    audit.record(db, p, "outlet.create", "outlet", o.id, {"code": o.code, "invoice_prefix": o.invoice_prefix})
    db.commit()
    return o


def update(db: Session, p, outlet_id: uuid.UUID, data) -> Outlet:
    o = get(db, p.restaurant_id, outlet_id, lock=True)
    sent = {k: getattr(data, k) for k in data.model_fields_set}
    changed = {}
    for k, v in sent.items():
        if k in ("name", "is_active", "timezone") and v is None:
            raise HTTPException(422, f"{k} cannot be null")
        if k == "timezone":
            _tz(v)
        if k == "is_active" and v is False and o.is_default:
            raise HTTPException(409, "The default outlet cannot be deactivated")
        if k in ("is_default", "country", "currency"):  # country / currency: IN / INR only (the schema refuses others)
            continue
        if k == "is_active" and v and not o.is_active:
            check_outlet_limit(db, p.restaurant_id)  # reactivating counts as adding one
        if getattr(o, k) != v:
            changed[k] = {"old": getattr(o, k), "new": v}
            setattr(o, k, v)
    if o.is_default and changed:  # the restaurant mirrors the default outlet's settings
        r = db.get(Restaurant, p.restaurant_id, with_for_update=True)
        for k in ("address", "phone", "trn", "timezone"):
            if k in changed:
                setattr(r, k, getattr(o, k))
        if "name" in changed:
            r.name = o.name
    if changed:
        audit.record(db, p, "outlet.update", "outlet", o.id, changed)
    db.commit()
    return o


# ------------------------------------------------------------------------------------------------ access (PR 7)
def resolve_access(db: Session, user, header: str | None, method: str, all_outlets: bool | None = None):
    """(current outlet id, accessible outlet ids) of a request. Owners / managers reach every outlet of the tenant; other
    users the outlets granted in user_outlet_access, else the default outlet only. `header` is X-Outlet-Id: absent = the default
    outlet (or the first granted one when the default is not granted), so old clients keep working. 404 unknown outlet (also
    another tenant's), 403 not accessible, 409 writing to an inactive outlet. `all_outlets` is the outlets.access_all permission
    (None = derive it from the user's role)."""
    rows = db.execute(select(Outlet.id, Outlet.is_default, Outlet.is_active).where(Outlet.restaurant_id == user.restaurant_id)
                      .order_by(Outlet.is_default.desc(), Outlet.created_at, Outlet.code)).all()
    if not rows:
        return None, None
    default = next((r.id for r in rows if r.is_default), rows[0].id)
    if all_outlets is None:
        all_outlets = user.role in (Role.owner, Role.manager)
    if all_outlets:
        allowed = [r.id for r in rows]
    else:
        granted = set(db.scalars(select(UserOutletAccess.outlet_id).where(UserOutletAccess.user_id == user.id)))
        allowed = [r.id for r in rows if r.id in granted] or [default]
    if header:
        try:
            wanted = uuid.UUID(header.strip())
        except ValueError:
            raise HTTPException(422, "X-Outlet-Id must be a UUID")
        row = next((r for r in rows if r.id == wanted), None)
        if row is None:
            raise HTTPException(404, "Outlet not found")
        if wanted not in allowed:
            raise HTTPException(403, "No access to this outlet")
        if not row.is_active and method not in ("GET", "HEAD", "OPTIONS"):
            raise HTTPException(409, "Outlet is inactive")
        return wanted, tuple(allowed)
    return (default if default in allowed else allowed[0]), tuple(allowed)


def visible(p, row) -> bool:
    """May this principal see / change a row of its tenant that belongs to an outlet? (Principals built without outlet access,
    such as background jobs, are not restricted.)"""
    ids = getattr(p, "outlet_ids", None)
    return ids is None or row.outlet_id in ids


def scope(p, outlet_id: uuid.UUID | None, *, all_by_default: bool) -> list[uuid.UUID]:
    """Outlet ids a list / report endpoint covers. Explicit `outlet_id` must be accessible (403). Without it: operational lists
    (tables, orders, KOTs, bills, printers) use the request's outlet, report-like lists every accessible outlet; for a
    single-outlet tenant both are the one outlet, i.e. exactly the behaviour from before outlets."""
    allowed = list(p.outlet_ids) if getattr(p, "outlet_ids", None) is not None else None
    if outlet_id is not None:
        if allowed is not None and outlet_id not in allowed:
            raise HTTPException(403, "No access to this outlet")
        return [outlet_id]
    if all_by_default and allowed is not None:
        return allowed
    return [p.outlet_id]


def require_all_outlets(db: Session, p) -> None:
    """Tenant-wide figures (the insight / analytics reports still sum every outlet): 403 unless the principal reaches ALL of the
    tenant's outlets (outlets.access_all, or grants / a single outlet that happen to cover them). Stops a role that holds
    reports.view but not outlets.access_all from reading other outlets' totals. Principals built without outlet scope pass."""
    ids = getattr(p, "outlet_ids", None)
    if ids is None or "outlets.access_all" in getattr(p, "permissions", ()):
        return
    every = set(db.scalars(select(Outlet.id).where(Outlet.restaurant_id == p.restaurant_id)))
    if not every <= set(ids):
        raise HTTPException(403, "This report covers every outlet; it needs the outlets.access_all permission")


def get_access(db: Session, restaurant_id: uuid.UUID, user_id: uuid.UUID) -> list[uuid.UUID]:
    return list(db.scalars(select(UserOutletAccess.outlet_id).where(
        UserOutletAccess.restaurant_id == restaurant_id, UserOutletAccess.user_id == user_id)))


def set_access(db: Session, p, user_id: uuid.UUID, outlet_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Owner only (route). Replaces the user's grants; an empty list resets them to 'default outlet only'."""
    from app.models.core import User
    target = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id).with_for_update())
    if target is None:
        raise HTTPException(404, "User not found")
    wanted = set(outlet_ids)
    found = set(db.scalars(select(Outlet.id).where(Outlet.restaurant_id == p.restaurant_id, Outlet.id.in_(wanted)))) if wanted else set()
    if found != wanted:
        raise HTTPException(404, "Outlet not found")
    old = set(get_access(db, p.restaurant_id, user_id))
    for oid in old - wanted:
        db.delete(db.get(UserOutletAccess, (user_id, oid)))
    for oid in wanted - old:
        db.add(UserOutletAccess(user_id=user_id, outlet_id=oid, restaurant_id=p.restaurant_id))
    if old != wanted:
        audit.record(db, p, "user.outlet_access", "user", user_id,
                     {"old": sorted(map(str, old)), "new": sorted(map(str, wanted))})
    db.commit()
    return sorted(wanted, key=str)
