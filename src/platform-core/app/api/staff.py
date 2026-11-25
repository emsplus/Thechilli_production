from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.auth import check_password_policy
from app.api.common import Page, get_or_404, paged, parse_uuid, snap, to_dict
from app.core import errors
from app.core.db import get_db
from app.core.deps import Principal, require
from app.core.permissions import ROLE_PERMISSIONS, ROLES
from app.core.security import hash_password, new_opaque_token
from app.models import RefreshToken, ServiceClient, StaffUser, utcnow
from app.services import step_up as step_up_svc
from app.services.audit import audit, security_event

router = APIRouter(tags=["staff"])


class StaffIn(BaseModel):
    email: EmailStr
    name: str
    role: str
    password: str


class StaffPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    is_active: bool | None = None


class ResetIn(BaseModel):
    new_password: str


def _revoke_sessions(db, staff_id):
    for t in db.scalars(select(RefreshToken).where(RefreshToken.staff_id == staff_id, RefreshToken.revoked_at.is_(None))):
        t.revoked_at = utcnow()


def _last_super_admin_guard(db, user: StaffUser):
    n = db.scalar(select(func.count()).select_from(StaffUser).where(StaffUser.role == "super_admin", StaffUser.is_active.is_(True)))
    if user.role == "super_admin" and user.is_active and n <= 1:
        raise errors.conflict("Cannot remove or demote the last active super_admin", "last_super_admin")


@router.get("/roles")
def roles(_: Principal = Depends(require("staff.read", staff_only=True))):
    return {r: sorted(p) for r, p in ROLE_PERMISSIONS.items()}


@router.get("/staff")
def list_staff(page: Page = Depends(), _: Principal = Depends(require("staff.read", staff_only=True)), db: Session = Depends(get_db)):
    return paged(db, select(StaffUser), page, StaffUser, StaffUser.created_at)


@router.post("/staff", status_code=201)
def create_staff(body: StaffIn, p: Principal = Depends(require("staff.manage", staff_only=True, step_up=True)), db: Session = Depends(get_db)):
    if body.role not in ROLES:
        raise errors.bad("Unknown role", "bad_role")
    check_password_policy(body.password)
    email = body.email.lower()
    if db.scalar(select(StaffUser).where(StaffUser.email == email)):
        raise errors.conflict("Email already registered")
    u = StaffUser(email=email, name=body.name, role=body.role, password_hash=hash_password(body.password), must_change_password=True)
    db.add(u)
    db.flush()
    audit(db, p, "staff.created", "staff_user", u.id, after=snap(u, "email", "name", "role"))
    return to_dict(u)


@router.patch("/staff/{staff_id}")
def patch_staff(staff_id: str, body: StaffPatch, request: Request, p: Principal = Depends(require("staff.manage", staff_only=True)),
                db: Session = Depends(get_db)):
    if body.role is not None or body.is_active is not None:  # privilege change: fresh second factor (docs/STEP_UP.md)
        step_up_svc.enforce(db, request, p)
    u = get_or_404(db, StaffUser, parse_uuid(staff_id), "Staff user")
    before = snap(u, "name", "role", "is_active")
    if body.role is not None and body.role not in ROLES:
        raise errors.bad("Unknown role", "bad_role")
    if (body.role and body.role != "super_admin") or body.is_active is False:
        _last_super_admin_guard(db, u)
    for f in ("name", "role", "is_active"):
        v = getattr(body, f)
        if v is not None:
            setattr(u, f, v)
    if body.is_active is False or (body.role and body.role != before["role"]):
        _revoke_sessions(db, u.id)
    audit(db, p, "staff.updated", "staff_user", u.id, before=before, after=snap(u, "name", "role", "is_active"))
    if body.role and body.role != before["role"]:
        security_event(db, "role_changed", "warn", staff_id=u.id, email=u.email, ip=p.ip, details={"from": before["role"], "to": body.role})
    return to_dict(u)


@router.post("/staff/{staff_id}/reset-password")
def reset_password(staff_id: str, body: ResetIn, p: Principal = Depends(require("staff.manage", staff_only=True, step_up=True)),
                   db: Session = Depends(get_db)):
    u = get_or_404(db, StaffUser, parse_uuid(staff_id), "Staff user")
    check_password_policy(body.new_password)
    u.password_hash, u.must_change_password = hash_password(body.new_password), True
    _revoke_sessions(db, u.id)
    audit(db, p, "staff.password_reset", "staff_user", u.id)
    security_event(db, "password_reset_by_admin", "warn", staff_id=u.id, email=u.email, ip=p.ip)
    return {"ok": True}


# ---------- service clients (machine credentials for pos-service / marketing-service) ----------
SERVICE_SCOPES = {"entitlements.read", "onboarding.submit", "onboarding.read", "subscriptions.read", "ai_usage.write", "heartbeat.write", "config.read", "tenants.read", "support_access.verify"}


class ServiceClientIn(BaseModel):
    name: str
    scopes: list[str]


@router.post("/service-clients", status_code=201)
def create_service_client(body: ServiceClientIn, p: Principal = Depends(require("service_clients.manage", staff_only=True, step_up=True)),
                          db: Session = Depends(get_db)):
    bad = set(body.scopes) - SERVICE_SCOPES
    if bad:
        raise errors.bad(f"Unknown scopes: {sorted(bad)}")
    if db.scalar(select(ServiceClient).where(ServiceClient.name == body.name)):
        raise errors.conflict("Service client name exists")
    key, h = new_opaque_token()
    sc = ServiceClient(name=body.name, key_hash=h, scopes=sorted(body.scopes))
    db.add(sc)
    db.flush()
    audit(db, p, "service_client.created", "service_client", sc.id, after={"name": sc.name, "scopes": sc.scopes})
    return {**to_dict(sc), "api_key": key, "note": "Store this key now; it cannot be shown again."}


@router.get("/service-clients")
def list_service_clients(_: Principal = Depends(require("service_clients.manage", staff_only=True)), db: Session = Depends(get_db)):
    return {"items": [to_dict(s) for s in db.scalars(select(ServiceClient).order_by(ServiceClient.name))]}


@router.post("/service-clients/{cid}/revoke")
def revoke_service_client(cid: str, p: Principal = Depends(require("service_clients.manage", staff_only=True, step_up=True)),
                          db: Session = Depends(get_db)):
    sc = get_or_404(db, ServiceClient, parse_uuid(cid), "Service client")
    sc.is_active = False
    audit(db, p, "service_client.revoked", "service_client", sc.id, after={"name": sc.name})
    return {"ok": True}
