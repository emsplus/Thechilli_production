"""Tenant provisioning for platform-core (docs/PROVISIONING.md): creates restaurant + owner + first outlet + default tax rates
in ONE transaction, idempotently, with the platform-core tenant id as the restaurant id.

RLS-safe the same way POST /auth/register-restaurant is: the tenant id is known BEFORE the first insert, so the session is bound
to it (app/core/tenancy.bind_tenant) and every INSERT satisfies the policy's WITH CHECK. The only global table is the
idempotency ledger `provisioning_requests` (no tenant column). The owner gets an unguessable random password hash (nobody
knows it) and a single-use, expiring, hashed invite token to set a real one (POST /auth/accept-invite). The raw token is never
stored: a replay while the invite is still pending issues a FRESH token (older unused ones are voided), so a lost response is
recoverable without keeping the secret.
"""
import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core import password_policy
from app.core.security import hash_password
from app.core.tenancy import bind_tenant
from app.models.core import Outlet, Restaurant, Role, RoleDef, TaxRate, User
from app.models.provisioning import ProvisioningRequest, UserInvite
from app.schemas.common import BusinessTypes, CountryCode, CurrencyCode, check_tax_number
from app.services import audit, business_type, localisation as L, outlets

ACCEPT_PATH = "/api/v1/auth/accept-invite"


def _err(status: int, code: str, message: str) -> HTTPException:
    e = HTTPException(status, message)
    e.code = code  # picked up by app/core/errors.py -> error.code
    return e


# ------------------------------------------------------------------------------------------------ request schema
class OwnerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr


class OutletIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=200)  # default: the business name
    address: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=30)


class ProvisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: uuid.UUID  # platform-core tenant id: becomes restaurants.id
    business_name: str = Field(min_length=1, max_length=200)
    country: CountryCode  # IN (anything else is a 422)
    timezone: str | None = Field(default=None, max_length=64)  # default: Asia/Kolkata
    currency: CurrencyCode | None = None  # INR (anything else is a 422); omitted = INR
    gstin: str | None = Field(default=None, max_length=30)
    owner: OwnerIn
    outlet: OutletIn = Field(default_factory=OutletIn)
    # What the business runs (docs/BUSINESS_TYPES.md): one or more of restaurant | cloud_kitchen | hotel_kitchen. Absent =
    # ["restaurant"] (a platform-core older than the business-types release keeps working).
    business_types: BusinessTypes = Field(default_factory=lambda: ["restaurant"])
    plan_code: str | None = Field(default=None, max_length=64)
    entitlement_hints: dict | None = None  # informational; platform-core entitlements are authoritative

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v):
        if v is not None:
            try:
                ZoneInfo(v)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("unknown timezone")
        return v

    @field_validator("entitlement_hints")
    @classmethod
    def _hints(cls, v):
        if v is not None and len(json.dumps(v)) > 4000:
            raise ValueError("entitlement_hints too large")
        return v

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v):
        return check_tax_number(v)


# ------------------------------------------------------------------------------------------------ helpers
def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _canonical(data: ProvisionIn) -> str:
    body = data.model_dump(mode="json")
    if body.get("business_types") == ["restaurant"]:
        del body["business_types"]  # the default hashes like a request made before the field existed (replays stay 200)
    return json.dumps(body, sort_keys=True, separators=(",", ":"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def issue_invite(db: Session, user: User) -> tuple[str, UserInvite]:
    """Voids the user's unused invites and issues a new one. Token = '<tenant uuid>.<secret>': the tenant prefix lets the public
    accept route bind the tenant before it reads anything (no cross-tenant lookup needed); only sha256(secret) is stored."""
    db.execute(update(UserInvite).where(UserInvite.user_id == user.id, UserInvite.accepted_at.is_(None),
                                        UserInvite.voided_at.is_(None)).values(voided_at=_now()))
    secret = secrets.token_urlsafe(32)
    inv = UserInvite(restaurant_id=user.restaurant_id, user_id=user.id, token_hash=sha256(secret),
                     expires_at=_now() + timedelta(hours=settings.provision_invite_hours))
    db.add(inv)
    db.flush()
    return f"{user.restaurant_id}.{secret}", inv


def _owner(db: Session, tenant_id: uuid.UUID) -> User | None:
    return db.scalars(select(User).where(User.restaurant_id == tenant_id, User.role == Role.owner)
                      .order_by(User.created_at)).first()


def invite_state(db: Session, user: User) -> str:
    """none | pending | expired | accepted."""
    if db.scalar(select(UserInvite.id).where(UserInvite.user_id == user.id, UserInvite.accepted_at.is_not(None)).limit(1)):
        return "accepted"
    inv = db.scalars(select(UserInvite).where(UserInvite.user_id == user.id, UserInvite.voided_at.is_(None))
                     .order_by(UserInvite.created_at.desc())).first()
    if inv is None:
        return "none"
    return "pending" if inv.expires_at > _now() else "expired"


def _invite_block(token: str | None, inv: UserInvite | None, state: str) -> dict:
    return {"status": state, "token": token, "expires_at": inv.expires_at.isoformat() if inv and token else None,
            "accept_path": ACCEPT_PATH}


def _response(db: Session, tenant_id: uuid.UUID, replayed: bool) -> dict:
    r = db.get(Restaurant, tenant_id)
    owner = _owner(db, tenant_id)
    outlet = db.scalar(select(Outlet).where(Outlet.restaurant_id == tenant_id, Outlet.is_default))
    state = invite_state(db, owner)
    token, inv = None, None
    if state in ("pending", "expired", "none"):  # a lost response is recoverable: a fresh token, older ones void
        token, inv = issue_invite(db, owner)
        state = "pending"
    return {
        "tenant_id": str(tenant_id), "restaurant_id": str(tenant_id), "status": "provisioned", "replayed": replayed,
        "country": r.country, "currency": r.currency, "timezone": r.timezone,
        "outlet_id": str(outlet.id), "owner_user_id": str(owner.id),
        "owner": {"email": owner.email, "invite": _invite_block(token, inv, state)},
    }


def _system_roles_present(db: Session) -> bool:
    return db.scalar(select(func.count()).select_from(RoleDef).where(RoleDef.restaurant_id.is_(None), RoleDef.is_system)) >= len(Role)


# ------------------------------------------------------------------------------------------------ create
def provision(db: Session, key: str, data: ProvisionIn, actor: str) -> tuple[dict, int]:
    """Returns (response body, http status): 201 on creation, 200 on an idempotent replay. 409 for a reused key with another
    body, 409 for a tenant id that exists but was not created by this key."""
    key_hash, req_hash = sha256(key), sha256(_canonical(data))
    tenant_id = bind_tenant(db, data.tenant_id)  # before any tenant-table statement (RLS)

    for _ in range(2):  # the second pass handles losing a race with a concurrent identical request
        prior = db.scalar(select(ProvisioningRequest).where(ProvisioningRequest.key_hash == key_hash))
        if prior is not None:
            if prior.request_hash != req_hash:
                raise _err(409, "idempotency_key_reused", "This Idempotency-Key was used with a different request")
            body = _response(db, prior.tenant_id, replayed=True)
            audit.record(db, SimpleNamespace(restaurant_id=tenant_id, user_id=None), "tenant.provision_replayed", "restaurant",
                         tenant_id, {"actor": actor})
            db.commit()
            return body, 200
        try:
            return _create(db, key_hash, req_hash, tenant_id, data, actor), 201
        except IntegrityError:
            db.rollback()  # unique key_hash / tenant_id: someone else just created it; re-read and replay (or 409)
            bind_tenant(db, tenant_id)
            if db.scalar(select(ProvisioningRequest.id).where(ProvisioningRequest.key_hash == key_hash)) is None:
                raise _err(409, "tenant_exists", "A tenant with this id already exists")
    raise _err(409, "conflict", "Concurrent provisioning, retry")


def _create(db: Session, key_hash: str, req_hash: str, tenant_id: uuid.UUID, data: ProvisionIn, actor: str) -> dict:
    if db.get(Restaurant, tenant_id) is not None:  # visible only because this tenant is bound
        raise _err(409, "tenant_exists", "A tenant with this id already exists")
    if not _system_roles_present(db):  # roles are seeded by the migrations/owner role; the app role cannot seed them
        raise _err(503, "roles_not_seeded", "System roles are not seeded")
    # The ledger row goes in FIRST: its unique keys serialise two concurrent identical requests (the loser gets IntegrityError).
    db.add(ProvisioningRequest(key_hash=key_hash, request_hash=req_hash, tenant_id=tenant_id, plan_code=data.plan_code,
                               hints=data.entitlement_hints))
    db.flush()
    r = Restaurant(id=tenant_id, name=data.business_name, trn=data.gstin, country=L.COUNTRY, currency=L.CURRENCY,
                   timezone=data.timezone or L.TIMEZONE, prices_include_tax=L.PRICES_INCLUDE_TAX,
                   business_types=data.business_types)
    db.add(r)
    db.flush()
    owner = User(restaurant_id=tenant_id, email=data.owner.email, full_name=data.owner.name, role=Role.owner,
                 password_hash=hash_password(secrets.token_urlsafe(48)))  # nobody knows it: the invite sets the real one
    db.add(owner)
    L.seed_rates(db, r)
    db.flush()
    o = outlets.create_default(db, r)
    if data.outlet.name:
        o.name = data.outlet.name
    o.address = r.address = data.outlet.address
    o.phone = r.phone = data.outlet.phone
    db.flush()
    token, inv = issue_invite(db, owner)
    audit.record(db, SimpleNamespace(restaurant_id=tenant_id, user_id=None), "tenant.provisioned", "restaurant", tenant_id,
                 {"actor": actor, "country": r.country, "plan_code": data.plan_code})  # never the key, token or hints
    body = {
        "tenant_id": str(tenant_id), "restaurant_id": str(tenant_id), "status": "provisioned", "replayed": False,
        "country": r.country, "currency": r.currency, "timezone": r.timezone,
        "outlet_id": str(o.id), "owner_user_id": str(owner.id),
        "owner": {"email": owner.email, "invite": _invite_block(token, inv, "pending")},
    }
    db.commit()
    return body


# ------------------------------------------------------------------------------------------------ status
def status(db: Session, tenant_id: uuid.UUID) -> dict | None:
    bind_tenant(db, tenant_id)
    r = db.get(Restaurant, tenant_id)
    if r is None:
        return None
    owner = _owner(db, tenant_id)
    n_outlets = db.scalar(select(func.count()).select_from(Outlet).where(Outlet.restaurant_id == tenant_id))
    n_tax = db.scalar(select(func.count()).select_from(TaxRate).where(TaxRate.restaurant_id == tenant_id))
    return {
        "tenant_id": str(tenant_id), "provisioned": True, "business_name": r.name, "country": r.country,
        "currency": r.currency, "timezone": r.timezone, "business_types": business_type.stored(r), "outlet_count": n_outlets, "tax_configured": n_tax > 0,
        "owner": {"email": owner.email, "invite_status": invite_state(db, owner)} if owner else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


# ------------------------------------------------------------------------------------------------ accept invite
def accept_invite(db: Session, token: str, password: str, device: str | None):
    """Single use, atomic: the UPDATE ... WHERE accepted_at IS NULL claims the invite, so two concurrent accepts cannot both win.
    Every failure is the same 400 (no oracle on tenant / token state). Returns the token pair of the owner."""
    from app.services import tokens  # local: tokens imports models
    bad = HTTPException(400, "Invalid or expired invite")
    tid, _, secret = token.partition(".")
    try:
        bind_tenant(db, uuid.UUID(tid))
    except ValueError:
        raise bad
    if not secret:
        raise bad
    claimed = db.execute(update(UserInvite).where(
        UserInvite.token_hash == sha256(secret), UserInvite.accepted_at.is_(None), UserInvite.voided_at.is_(None),
        UserInvite.expires_at > func.now()).values(accepted_at=func.now()).returning(UserInvite.user_id)).first()
    if claimed is None:
        db.rollback()
        raise bad
    u = db.get(User, claimed.user_id)
    if not u.is_active:  # a deactivated staff member's pending invite opens nothing
        db.rollback()
        raise bad
    password_policy.enforce(password, u.email, u.full_name)  # security review finding 7
    u.password_hash = hash_password(password)
    u.must_change_password = False
    tokens.revoke_user(db, u.id, "password_reset")
    audit.record(db, SimpleNamespace(restaurant_id=u.restaurant_id, user_id=u.id), "user.invite_accepted", "user", u.id)
    _, out = tokens.issue_pair(db, u, device)
    db.commit()
    return out
