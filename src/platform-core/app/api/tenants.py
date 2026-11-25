import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator, BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import Page, get_or_404, paged, parse_uuid, snap, to_dict
from app.core import errors
from app.core.db import get_db
from app.core.deps import Principal, require
from app.models import BusinessProfile, Outlet, Subscription, Tenant, canonical_business_types, utcnow
from app.services import entitlements as ent
from app.services import wallet
from app.services.audit import audit
from app.services.tenants import unique_slug

router = APIRouter(tags=["tenants"])
GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")  # format only; no checksum / tax rules
PAN_RE = re.compile(r"^[A-Z]{5}\d{4}[A-Z]$")


class ProfileIn(BaseModel):
    legal_name: str
    gstin: str | None = None
    pan: str | None = None
    fssai: str | None = None
    state_code: str | None = Field(None, pattern=r"^\d{2}$")
    address: str | None = None
    city: str | None = None
    pincode: str | None = Field(None, pattern=r"^\d{6}$")
    contact_name: str | None = None
    contact_email: EmailStr | None = None
    contact_phone: str | None = None

    @field_validator("gstin")
    @classmethod
    def _g(cls, v):
        if v and not GSTIN_RE.match(v.upper()):
            raise ValueError("invalid GSTIN format")
        return v.upper() if v else v

    @field_validator("pan")
    @classmethod
    def _p(cls, v):
        if v and not PAN_RE.match(v.upper()):
            raise ValueError("invalid PAN format")
        return v.upper() if v else v


BusinessType = Literal["restaurant", "cloud_kitchen", "hotel_kitchen"]  # models.BUSINESS_TYPES
# One or more types: unknown value or empty list -> 422; deduplicated and returned in canonical order.
BusinessTypes = Annotated[list[BusinessType], Field(min_length=1, max_length=3), AfterValidator(canonical_business_types)]


def default_business_types() -> list[str]:
    return ["restaurant"]


class TenantIn(BaseModel):
    display_name: str
    business_types: BusinessTypes = Field(default_factory=default_business_types)
    profile: ProfileIn


class TenantPatch(BaseModel):
    display_name: str | None = None
    business_types: BusinessTypes | None = None
    reason: str | None = Field(None, max_length=500)  # recorded in entitlement history / audit when business_types change


class StatusChange(BaseModel):
    reason: str = Field(min_length=3)


class OutletIn(BaseModel):
    name: str
    code: str | None = None
    city: str | None = None
    state_code: str | None = Field(None, pattern=r"^\d{2}$")


class OutletPatch(BaseModel):
    name: str | None = None
    city: str | None = None
    state_code: str | None = Field(None, pattern=r"^\d{2}$")
    status: str | None = Field(None, pattern="^(active|inactive)$")


def tenant_view(db: Session, t: Tenant) -> dict:
    prof = db.get(BusinessProfile, t.id)
    return {**to_dict(t), "profile": to_dict(prof) if prof else None,
            "outlets": [to_dict(o) for o in db.scalars(select(Outlet).where(Outlet.tenant_id == t.id).order_by(Outlet.created_at))]}


def resolve_tenant(db: Session, ref: str) -> Tenant:
    """Accepts a tenant UUID or slug."""
    try:
        t = db.get(Tenant, parse_uuid(ref))
    except errors.AppError:
        t = None
    if t is None:
        t = db.scalar(select(Tenant).where(Tenant.slug == ref))
    if t is None:
        raise errors.not_found("Tenant not found")
    return t


def set_profile(db: Session, tenant_id, data: ProfileIn) -> BusinessProfile:
    prof = db.get(BusinessProfile, tenant_id)
    if prof is None:
        prof = BusinessProfile(tenant_id=tenant_id, legal_name=data.legal_name)
        db.add(prof)
    for k, v in data.model_dump().items():
        setattr(prof, k, v)
    prof.updated_at = utcnow()
    return prof


@router.post("/tenants", status_code=201)
def create_tenant(body: TenantIn, p: Principal = Depends(require("tenants.write", staff_only=True)), db: Session = Depends(get_db)):
    t = Tenant(slug=unique_slug(db, body.display_name), display_name=body.display_name, status="pending",
               business_types=body.business_types)
    db.add(t)
    db.flush()
    set_profile(db, t.id, body.profile)
    wallet.ensure_wallet(db, t)  # PAYG: the free trial starts at tenant creation (docs/PAYG_BILLING.md)
    audit(db, p, "tenant.created", "tenant", t.id, t.id, after=snap(t, "slug", "display_name", "status", "business_types"))
    return tenant_view(db, t)


@router.get("/tenants")
def list_tenants(page: Page = Depends(), status: str | None = None, q: str | None = None,
                 business_types: list[BusinessType] | None = Query(None),
                 _: Principal = Depends(require("tenants.read", staff_only=True)), db: Session = Depends(get_db)):
    stmt = select(Tenant)
    if status:
        stmt = stmt.where(Tenant.status == status)
    if business_types:  # ?business_types=cloud_kitchen[&business_types=...]: tenants whose selection includes all of them
        stmt = stmt.where(Tenant.business_types.contains(business_types))
    if q:
        stmt = stmt.where(Tenant.display_name.ilike(f"%{q}%") | Tenant.slug.ilike(f"%{q}%"))
    return paged(db, stmt, page, Tenant, Tenant.created_at.desc())


@router.get("/tenants/{ref}")
def get_tenant(ref: str, _: Principal = Depends(require("tenants.read", staff_only=True)), db: Session = Depends(get_db)):
    return tenant_view(db, resolve_tenant(db, ref))


@router.patch("/tenants/{ref}")
def patch_tenant(ref: str, body: TenantPatch, p: Principal = Depends(require("tenants.write", staff_only=True)),
                 db: Session = Depends(get_db)):
    """display_name and/or business_types (the full new selection). A change re-derives the business-type entitlement defaults
    here (diff recorded in entitlement_history, trigger `business_types_changed`). Adding a type never removes data; removing
    one only changes defaults. For a provisioned tenant the selection is then pushed to pos-service
    (PUT /internal/provision/tenants/{id}/business-types, idempotent; pos-service hides / shows tables, dine-in, reservations).
    The response's `pos_sync` says how that went: synced | not_provisioned | not_found | failed:<code>. A failed push never
    fails the PATCH: send the same business_types again to retry (docs/PROVISIONING.md)."""
    t = resolve_tenant(db, ref)
    before = snap(t, "display_name", "business_types")
    before["business_types"] = list(before["business_types"] or [])
    if body.display_name:
        t.display_name = body.display_name
    if body.business_types and body.business_types != before["business_types"]:
        def mutate():
            t.business_types = list(body.business_types)
        ent.tracked_change(db, t, "business_types_changed", p.label, body.reason, mutate)
        audit(db, p, "tenant.business_types_changed", "tenant", t.id, t.id, before={"business_types": before["business_types"]},
              after={"business_types": t.business_types}, meta={"reason": body.reason} if body.reason else None)
    audit(db, p, "tenant.updated", "tenant", t.id, t.id, before=before, after=snap(t, "display_name", "business_types"))
    out = tenant_view(db, t)
    if body.business_types:
        out["pos_sync"] = push_business_types(db, p, t, body.reason)
    return out


def push_business_types(db: Session, p: Principal, t: Tenant, reason: str | None) -> str:
    """Sends the tenant's selection to pos-service (its runtime source). Never raises."""
    from app.services.provisioner import ProvisioningError, get_provisioner
    if not t.pos_tenant_ref:
        return "not_provisioned"  # the provision request will carry the selection
    try:
        res = "synced" if get_provisioner().set_business_types(t.pos_tenant_ref, list(t.business_types), reason) else "not_found"
    except ProvisioningError as e:
        res = f"failed:{e.code}"
    except Exception:  # pragma: no cover - a bug in the client must not lose the platform-core change
        res = "failed:error"
    audit(db, p, "tenant.business_types_pushed", "tenant", t.id, t.id, after={"business_types": list(t.business_types)},
          meta={"result": res})
    return res


@router.put("/tenants/{ref}/profile")
def put_profile(ref: str, body: ProfileIn, p: Principal = Depends(require("tenants.write", staff_only=True)),
                db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    old = db.get(BusinessProfile, t.id)
    before = to_dict(old) if old else None
    prof = set_profile(db, t.id, body)
    db.flush()
    audit(db, p, "tenant.profile_updated", "tenant", t.id, t.id, before=before, after=to_dict(prof))
    return tenant_view(db, t)


def _change_status(db, p, t: Tenant, to: str, reason: str, action: str, allowed_from: set[str]):
    if t.status not in allowed_from:
        raise errors.conflict(f"Cannot move tenant from {t.status} to {to}", "bad_transition")

    def mutate():
        t.status, t.status_reason, t.status_changed_at = to, reason, utcnow()
    ent.tracked_change(db, t, f"tenant_{to}", p.label, reason, mutate)


@router.post("/tenants/{ref}/suspend")
def suspend(ref: str, body: StatusChange, p: Principal = Depends(require("tenants.suspend", staff_only=True, step_up=True)),
            db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    before = t.status
    _change_status(db, p, t, "suspended", body.reason, "suspend", {"active"})
    audit(db, p, "tenant.suspended", "tenant", t.id, t.id, before={"status": before}, after={"status": t.status}, meta={"reason": body.reason})
    return tenant_view(db, t)


@router.post("/tenants/{ref}/reactivate")
def reactivate(ref: str, body: StatusChange, p: Principal = Depends(require("tenants.suspend", staff_only=True, step_up=True)),
               db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    before = t.status
    _change_status(db, p, t, "active", body.reason, "reactivate", {"suspended"})
    audit(db, p, "tenant.reactivated", "tenant", t.id, t.id, before={"status": before}, after={"status": t.status}, meta={"reason": body.reason})
    return tenant_view(db, t)


@router.post("/tenants/{ref}/close")
def close(ref: str, body: StatusChange, p: Principal = Depends(require("tenants.suspend", staff_only=True, step_up=True)),
          db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    before = t.status
    _change_status(db, p, t, "closed", body.reason, "close", {"active", "suspended", "pending"})
    sub = ent.live_subscription(db, t.id)
    if sub:
        sub.status, sub.ended_at = "cancelled", utcnow()
    audit(db, p, "tenant.closed", "tenant", t.id, t.id, before={"status": before}, after={"status": t.status}, meta={"reason": body.reason})
    return tenant_view(db, t)


@router.post("/tenants/{ref}/outlets", status_code=201)
def add_outlet(ref: str, body: OutletIn, p: Principal = Depends(require("tenants.write", staff_only=True)), db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    if body.code and db.scalar(select(Outlet.id).where(Outlet.tenant_id == t.id, Outlet.code == body.code)):
        raise errors.conflict("Outlet code already used for this tenant")
    o = Outlet(tenant_id=t.id, **body.model_dump())
    db.add(o)
    db.flush()
    audit(db, p, "outlet.created", "outlet", o.id, t.id, after=to_dict(o))
    return to_dict(o)


@router.patch("/tenants/{ref}/outlets/{outlet_id}")
def patch_outlet(ref: str, outlet_id: str, body: OutletPatch, p: Principal = Depends(require("tenants.write", staff_only=True)),
                 db: Session = Depends(get_db)):
    t = resolve_tenant(db, ref)
    o = get_or_404(db, Outlet, parse_uuid(outlet_id), "Outlet")
    if o.tenant_id != t.id:
        raise errors.not_found("Outlet not found")
    before = to_dict(o)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(o, k, v)
    audit(db, p, "outlet.updated", "outlet", o.id, t.id, before=before, after=to_dict(o))
    return to_dict(o)


Subscription  # noqa
