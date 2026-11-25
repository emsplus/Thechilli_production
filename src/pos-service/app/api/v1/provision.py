"""Service-principal provisioning API (docs/PROVISIONING.md). Called by platform-core only; NOT a tenant route, so it has no
principal / entitlement handling and is mounted outside /api/v1. Authentication: a dedicated key (X-Provision-Key) whose sha256
is configured in PROVISION_KEY_SHA256, compared in constant time; scopes from PROVISION_KEY_SCOPES; optional IP allowlist."""
import hmac
import ipaddress
import logging
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core import password_policy
from app.core.config import settings
from app.core.db import get_db
from app.schemas.common import BusinessTypes, TokenOut
from app.services import abuse, provisioning
from app.services.provisioning import ProvisionIn, sha256

log = logging.getLogger("app.provision")
router = APIRouter(prefix="/internal/provision", tags=["provisioning"])
accept_router = APIRouter(prefix="/auth", tags=["auth"])  # mounted under /api/v1


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _ip_allowed(ip: str) -> bool:
    entries = [e.strip() for e in settings.provision_ip_allowlist.split(",") if e.strip()]
    if not entries:
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for e in entries:
        try:
            if addr in ipaddress.ip_network(e, strict=False):
                return True
        except ValueError:
            continue
    return False


def provision_auth(scope: str):
    def dep(request: Request, x_provision_key: str | None = Header(default=None)) -> str:
        configured = settings.provision_key_sha256.strip().lower()
        if not configured:
            raise HTTPException(404, "Not found")  # disabled: indistinguishable from an unknown route
        ip = _client_ip(request)
        if not _ip_allowed(ip):
            log.warning("provision: rejected address %s", ip)
            raise HTTPException(403, "Forbidden")
        fail_key = f"provision:ip:{ip}"
        if abuse.locked_for([fail_key]):
            raise HTTPException(429, "Too many failed attempts. Try again later.")
        ok = bool(x_provision_key) and hmac.compare_digest(sha256(x_provision_key), configured)
        if not ok:
            abuse.hit(fail_key, window=timedelta(minutes=15), limit=settings.provision_fail_per_ip_per_15min)
            log.warning("provision: invalid key from %s", ip)  # never the presented key
            raise HTTPException(401, "Invalid credentials")
        scopes = {s.strip() for s in settings.provision_key_scopes.split(",") if s.strip()}
        if scope not in scopes:
            log.warning("provision: key lacks scope %s", scope)
            raise HTTPException(403, "Forbidden")
        return "platform-core"
    return dep


@router.post("/tenants")
def create_tenant(data: ProvisionIn, db: Session = Depends(get_db),
                  actor: str = Depends(provision_auth("provision.create")),
                  idempotency_key: str | None = Header(default=None, min_length=8, max_length=200)):
    from fastapi.responses import JSONResponse
    if not idempotency_key:
        raise HTTPException(422, "Idempotency-Key header is required")
    body, code = provisioning.provision(db, idempotency_key, data, actor)
    return JSONResponse(body, status_code=code)


@router.get("/tenants/{tenant_id}/status")
def tenant_status(tenant_id: uuid.UUID, db: Session = Depends(get_db), _: str = Depends(provision_auth("provision.read"))):
    out = provisioning.status(db, tenant_id)
    if out is None:
        raise HTTPException(404, "Tenant not found")
    return out


class BusinessTypesUpdateIn(BaseModel):
    business_types: BusinessTypes
    reason: str | None = Field(default=None, max_length=300)


@router.put("/tenants/{tenant_id}/business-types")
def set_business_types(tenant_id: uuid.UUID, data: BusinessTypesUpdateIn, db: Session = Depends(get_db),
                       actor: str = Depends(provision_auth("provision.create"))):
    """Platform staff change (via platform-core, scope provision.create): replaces the tenant's business types. Unlike the
    owner's PUT /api/v1/restaurant/business-types it is allowed with open orders (staff decision). Idempotent; audit-logged
    (restaurant.business_types, detail.by = platform). Nothing is deleted: removed types only hide their features."""
    from app.core.tenancy import bind_tenant
    from app.models.core import Restaurant
    from app.services import business_type
    bind_tenant(db, tenant_id)
    r = db.get(Restaurant, tenant_id, with_for_update=True)
    if r is None:
        raise HTTPException(404, "Tenant not found")
    out = business_type.change(db, r, data.business_types, business_type.system_actor(tenant_id), staff=True,
                               reason=data.reason)
    db.commit()
    return {"tenant_id": str(tenant_id), **out, "capabilities": business_type.capabilities(out["after"])}


class AcceptInviteIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=10, max_length=200)

    @field_validator("password")
    @classmethod
    def _password_policy(cls, v: str) -> str:  # security review finding 7 (accept_invite adds the email / name check)
        return password_policy.validate(v)


@accept_router.post("/accept-invite", response_model=TokenOut)
def accept_invite(data: AcceptInviteIn, request: Request, db: Session = Depends(get_db)):
    """Owner sets the first password with the single-use invite token from the provisioning email."""
    abuse.throttle([(f"invite:ip:{_client_ip(request)}", 30)], window=timedelta(hours=1), what="attempts")
    return provisioning.accept_invite(db, data.token, data.password, request.headers.get("user-agent"))
