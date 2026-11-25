import uuid
from dataclasses import dataclass
from datetime import timedelta

import jwt
import logging
import re
from types import SimpleNamespace

from fastapi import Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core import permissions
from app.core.permissions import P  # noqa: F401  (re-exported for the routers)
from app.core.security import decode_token
from app.core.tenancy import bind_tenant
from app.models.core import Restaurant, Role, User
from app.services import entitlements, feature_access, outlets, staff_pin, support_access
from app.services.entitlements import EntitlementError

log = logging.getLogger("app.entitlements")

bearer = HTTPBearer(auto_error=False)


@dataclass
class Principal:
    user_id: uuid.UUID
    restaurant_id: uuid.UUID
    role: Role
    # The outlet this request works in: the tenant's default outlet (PR 5); PR 7 adds an optional X-Outlet-Id switch.
    outlet_id: uuid.UUID | None = None
    # Outlets this user may work in (None = unrestricted, for principals built outside a request).
    outlet_ids: tuple[uuid.UUID, ...] | None = None
    # What this user may do (app/core/permissions.py). Principals built outside a request get their role's permissions.
    permissions: frozenset[str] | None = None
    # Verified claims of a platform-core support token (services/support_access.py); None for a normal tenant user.
    support: dict | None = None
    # A staff session started with a PIN on a counter device (docs/STAFF_PIN_DEVICES_API.md): {session_id, counter_device_id,
    # outlet_id, expires_at, idle_expires_at}; None for a password session.
    pin_session: dict | None = None
    # True when the request carried a valid X-Step-Up-Token of this user (POST /auth/step-up, 5 minutes).
    step_up: bool = False

    def __post_init__(self):
        if self.permissions is None:
            self.permissions = permissions.system_role_permissions(self.role)

    def can(self, *perms: str) -> bool:
        """True if the principal holds ANY of the permissions."""
        return any(x in self.permissions for x in perms)


SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
# Writes that stay allowed while a tenant is suspended: ending the day, and the session housekeeping of signed-in users.
READ_ONLY_ALLOWED = (("POST", re.compile(r"/reports/z-report$")), ("POST", re.compile(r"/auth/(change-password)$")))
# Feature names used by require_feature -> platform-core feature codes (platform-core scripts/seed_catalog.py). delivery and
# aggregator are the optional modules a business-type selection turns on by default (docs/BUSINESS_TYPES.md).
FEATURES = {"voice": "ai.copilot", "ai": "ai.copilot", "inventory": "inventory", "kds": "kds", "delivery": "delivery",
            "aggregator": "aggregator",
            "marketing": "marketing.campaigns", "table_qr": "table_qr",
            # feature access (services/feature_access.py): back-office modules super admin grants and the owner may switch off
            "reports": "reports", "cash_drawer": "cash_drawer", "customers": "customers", "expenses": "expenses"}


def _suspended_error(e: entitlements.Entitlements) -> EntitlementError:
    if e.source == "grace_expired":
        return EntitlementError(402, "entitlements_unavailable",
                                "Billing status could not be verified for too long: the restaurant is read-only. Reads and ending the day still work.")
    return EntitlementError(402, "tenant_suspended",
                            "This restaurant's subscription is suspended: read-only mode. Reads and ending the day still work.")


def enforce_request(p: "Principal", request: Request, response: Response) -> None:
    """Entitlement checks every authenticated request goes through (ENTITLEMENTS_ENFORCE=off: nothing happens)."""
    mode = entitlements.mode()
    if mode == "off" or p.support:
        return
    e = entitlements.cache().get(p.restaurant_id)
    request.state.entitlements = e
    warning = e.warning
    if e.suspended and request.method not in SAFE_METHODS:
        path = request.url.path
        if not any(m == request.method and rx.search(path) for m, rx in READ_ONLY_ALLOWED):
            if mode == "on":
                raise _suspended_error(e)
            log.warning("entitlements(warn): would block %s %s for suspended tenant %s", request.method, path, p.restaurant_id)
    if e.suspended and mode == "warn":
        warning = "suspended"
    if warning:
        response.headers["X-Entitlement-Warning"] = warning


def require_feature(name: str):
    """Router/endpoint guard: 403 `feature_not_entitled` when the tenant's plan lacks the feature (mode on; warn only logs).
    A code absent from the tenant's map is allowed unless ENTITLEMENTS_ABSENT_FEATURE=deny. A suspended tenant is handled by
    the read-only rule, not here, so its reads keep working."""
    code = FEATURES[name]  # unknown names fail at import time

    def checker(request: Request, p: "Principal" = Depends(current_principal), db: Session = Depends(get_db)) -> "Principal":
        if p.support:
            return p
        mode = entitlements.mode()
        if mode != "off":
            e = entitlements.cache().get(p.restaurant_id)
            if not e.suspended and not e.feature_enabled(code):
                if mode == "on":
                    raise EntitlementError(403, "feature_not_entitled", f"Your plan does not include {name}")
                log.warning("entitlements(warn): tenant %s lacks feature %s (%s)", p.restaurant_id, name, code)
        # the owner's own switch (Manage > Features) holds under every mode
        feature_access.require(db, p.restaurant_id, code, grant=False)
        return p

    checker.feature = name
    return checker


def _support_principal(request: Request, db: Session, token: str) -> "Principal":
    claims = support_access.verify(token)
    if request.method not in SAFE_METHODS:
        raise EntitlementError(403, "support_read_only", "Support access is read-only")
    bind_tenant(db, claims["tenant_id"])
    if db.get(Restaurant, uuid.UUID(claims["tenant_id"])) is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    support_access.record(db, claims, request.method, request.url.path)
    uid = support_access.staff_uuid(claims)
    ghost = SimpleNamespace(id=uid, restaurant_id=uuid.UUID(claims["tenant_id"]), role=Role.manager)
    outlet_id, outlet_ids = outlets.resolve_access(db, ghost, request.headers.get("x-outlet-id"), request.method, all_outlets=True)
    view = frozenset(x for x in permissions.system_role_permissions(Role.owner) if x.endswith((".view", ".read")))
    return Principal(uid, ghost.restaurant_id, Role.manager, outlet_id, outlet_ids, view, support=claims)


def current_principal(
    request: Request,
    response: Response,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> Principal:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    if settings.support_access_enabled and support_access.looks_like_support_token(creds.credentials):
        return _support_principal(request, db, creds.credentials)
    try:
        claims = decode_token(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    try:
        # The tenant comes from the SIGNED claim and is bound before anything is read (under RLS a user of another
        # tenant is then simply invisible -> 401 below).
        bind_tenant(db, claims["rid"])
        user_id = uuid.UUID(claims["sub"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    user = db.get(User, user_id)
    if not user or not user.is_active or str(user.restaurant_id) != claims["rid"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid user")
    cut = user.sessions_valid_after
    if cut is not None and float(claims.get("iat") or 0) < cut.timestamp():  # signed out by a reset (security review 11)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session ended. Sign in again.")
    # Role and permissions are read from the DB, never trusted from the token.
    perms = permissions.resolve(db, user)
    pin = None
    if "ps" in claims:  # a PIN session on a counter device: live session row, its outlet only, no account administration
        try:
            sid = uuid.UUID(claims["ps"])
        except (ValueError, TypeError):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
        s = staff_pin.session_state(db, sid, user.id)
        header = request.headers.get("x-outlet-id")
        if header and header.strip() != str(s.outlet_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This counter session works in its device's outlet only")
        outlet_id, _ = outlets.resolve_access(db, user, str(s.outlet_id), request.method,
                                              all_outlets=P.OUTLETS_ACCESS_ALL in perms)
        outlet_ids = (s.outlet_id,)
        perms = perms - staff_pin.excluded_permissions()
        pin = {"session_id": s.id, "counter_device_id": s.counter_device_id, "outlet_id": s.outlet_id,
               "expires_at": s.expires_at,
               "idle_expires_at": s.last_activity_at + timedelta(minutes=settings.pin_idle_minutes)}
    else:
        # The outlet of this request: X-Outlet-Id (validated against the user's access) or the default outlet (old clients).
        outlet_id, outlet_ids = outlets.resolve_access(db, user, request.headers.get("x-outlet-id"), request.method,
                                                       all_outlets=P.OUTLETS_ACCESS_ALL in perms)
    p = Principal(user.id, user.restaurant_id, user.role, outlet_id, outlet_ids, perms, pin_session=pin,
                  step_up=staff_pin.verify_step_up(request.headers.get("x-step-up-token"), user.id, user.restaurant_id))
    enforce_request(p, request, response)
    return p


def require_perm(*perms: str):
    """Endpoint guard: 403 unless the principal holds ANY of `perms`. Unknown names fail at import time."""
    permissions.validate(perms)

    def checker(p: Principal = Depends(current_principal)) -> Principal:
        if not p.can(*perms):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return p

    checker.perms = perms
    return checker


def require_roles(*roles: Role):
    """Legacy enum-role check, kept for the transition (no router uses it any more; use require_perm). It ignores custom
    roles, so do not use it for new endpoints."""
    def checker(p: Principal = Depends(current_principal)) -> Principal:
        if p.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return p

    checker.roles = roles
    return checker


ADMIN = (Role.owner, Role.manager)
