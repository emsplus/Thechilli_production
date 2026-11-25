import hmac
import ipaddress
import json
from dataclasses import dataclass, field

import jwt
from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.permissions import ROLE_PERMISSIONS
from app.core.security import decode_token, sha256
from app.models import RefreshToken, ServiceClient, StaffUser, utcnow
from app.services import step_up as step_up_svc
from app.services.audit import security_event


@dataclass
class Principal:
    kind: str  # staff | service
    id: object
    label: str
    ip: str | None
    role: str | None = None
    permissions: frozenset = field(default_factory=frozenset)
    scopes: frozenset = field(default_factory=frozenset)
    session_id: str | None = None
    mfa: bool = False

    def can(self, perm: str) -> bool:
        return perm in self.permissions or perm in self.scopes


def _trusted(host: str) -> bool:
    entries = [e.strip() for e in settings.trusted_proxies.split(",") if e.strip()]
    if not entries:
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return host in entries  # non-IP peer (e.g. unix socket / test client): exact match only
    for e in entries:
        try:
            if addr in ipaddress.ip_network(e, strict=False):
                return True
        except ValueError:
            continue
    return False


def client_ip(request: Request) -> str:
    """The caller's address. X-Forwarded-For is honoured only when the direct peer is in TRUSTED_PROXIES, and is
    walked right-to-left skipping trusted hops, so a client-supplied left-most entry can never pick the key."""
    peer = request.client.host if request.client else "unknown"
    if not _trusted(peer):
        return peer
    hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    for hop in reversed(hops):
        try:
            ipaddress.ip_address(hop)
        except ValueError:
            return peer  # garbage in the chain: do not trust any of it
        if not _trusted(hop):
            return hop
    return peer


def norm_scope(s: str) -> str:
    return s.strip().replace(":", ".")


def env_service_keys() -> dict[str, tuple[str, frozenset]]:
    """name -> (key sha256 hex, scopes) from SERVICE_KEYS. Malformed config fails closed (no env clients)."""
    raw = settings.service_keys.strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return {str(n): (str(c["key_sha256"]).lower(), frozenset(norm_scope(x) for x in c.get("scopes", [])))
                for n, c in data.items()}
    except (ValueError, KeyError, TypeError, AttributeError):
        return {}


def _env_service(key: str) -> tuple[str, frozenset] | None:
    digest, found = sha256(key), None
    for name, (h, scopes) in env_service_keys().items():  # no early exit: constant work per configured client
        if hmac.compare_digest(digest, h):
            found = (name, scopes)
    return found


def _staff_from_bearer(request: Request, db: Session) -> Principal | None:
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        return None
    try:
        claims = decode_token(h[7:].strip(), settings.jwt_audience_staff, "staff_access")
    except jwt.PyJWTError:
        security_event(db, "token_invalid", "warn", ip=client_ip(request))
        db.commit()
        raise errors.unauthorized()
    user = db.get(StaffUser, claims["sub"])
    if user is None or not user.is_active:
        raise errors.unauthorized()
    sid = claims.get("sid")
    if sid and not db.scalar(select(RefreshToken.id).where(RefreshToken.family_id == sid, RefreshToken.revoked_at.is_(None)).limit(1)):
        raise errors.unauthorized("Session ended")  # revoked sessions stop working immediately, not at token expiry
    if user.role in settings.mfa_roles and not claims.get("mfa"):
        raise errors.unauthorized("Multi-factor authentication required")  # e.g. role promoted since sign-in
    # Permissions come from the DB role (not the token) so a demotion takes effect immediately.
    return Principal("staff", user.id, user.email, client_ip(request), user.role, ROLE_PERMISSIONS[user.role],
                     session_id=sid, mfa=bool(claims.get("mfa")))


def _service_from_key(request: Request, db: Session) -> Principal | None:
    key = request.headers.get("x-service-key")
    if not key:
        return None
    env = _env_service(key)
    if env is not None:
        return Principal("service", f"env:{env[0]}", f"service:{env[0]}", client_ip(request), scopes=env[1])
    sc = db.scalar(select(ServiceClient).where(ServiceClient.key_hash == sha256(key), ServiceClient.is_active.is_(True)))
    if sc is None:
        security_event(db, "service_key_invalid", "warn", ip=client_ip(request))
        db.commit()
        raise errors.unauthorized()
    sc.last_used_at = utcnow()
    return Principal("service", sc.id, f"service:{sc.name}", client_ip(request), scopes=frozenset(norm_scope(x) for x in (sc.scopes or [])))


def authenticate(request: Request, db: Session) -> Principal | None:
    return _staff_from_bearer(request, db) or _service_from_key(request, db)


def require(perm: str, *, staff_only: bool = False, service_scope: str | None = None, step_up: bool = False):
    """Dependency: staff holding `perm`, or (unless staff_only) a service client holding `service_scope`.
    `step_up=True`: the action also needs a fresh second factor (header X-Step-Up-Token, docs/STEP_UP.md)."""
    def dep(request: Request, db: Session = Depends(get_db)) -> Principal:
        p = authenticate(request, db)
        if p is None:
            raise errors.unauthorized()
        ok = (p.kind == "staff" and perm in p.permissions) or \
             (p.kind == "service" and not staff_only and (service_scope or perm) in p.scopes)
        if not ok:
            security_event(db, "permission_denied", "warn", staff_id=p.id if p.kind == "staff" else None,
                           email=p.label, ip=p.ip, details={"needed": perm, "path": request.url.path})
            db.commit()
            raise errors.forbidden()
        if step_up:
            step_up_svc.enforce(db, request, p)
        return p
    return dep


def current_staff(request: Request, db: Session = Depends(get_db)) -> Principal:
    p = _staff_from_bearer(request, db)
    if p is None:
        raise errors.unauthorized()
    return p
