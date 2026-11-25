import hashlib
import hmac
import uuid
from dataclasses import dataclass

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.security import decode_token
from app.models import MarketingUser, Role

bearer = HTTPBearer(auto_error=False)


@dataclass
class Principal:
    user_id: uuid.UUID | None
    role: Role
    service: str | None = None  # set for a service-key caller (read-only routes only, see read_roles)

    @property
    def is_admin(self) -> bool:
        return self.role == Role.marketing_admin


def current_principal(creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                      db: Session = Depends(get_db)) -> Principal:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        claims = decode_token(creds.credentials)
        user = db.get(MarketingUser, uuid.UUID(claims["sub"]))
    except (jwt.PyJWTError, ValueError, KeyError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid user")
    # Role is read from the DB, never trusted from the token alone.
    return Principal(user.id, user.role)


def require_roles(*roles: Role):
    def checker(p: Principal = Depends(current_principal)) -> Principal:
        if p.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return p

    return checker


# ---------------------------------------------------------------------------------------------- service keys
SERVICE_READ_SCOPE = "marketing.read"


def service_principal(raw_key: str, scope: str) -> Principal:
    """X-Service-Key -> a read-only principal (security review finding 5: platform-core used a 365-day marketing_admin
    bearer token). Only the sha256 of each key is configured (SERVICE_KEYS); comparison is constant-time. 401 for an
    unknown key, 403 for a known key without `scope`."""
    digest = hashlib.sha256(raw_key.encode()).hexdigest()
    match = None
    for name, entry in (settings.service_keys or {}).items():
        want = str((entry or {}).get("key_sha256", "")).lower()
        if want and hmac.compare_digest(digest, want):
            match = (name, entry)
    if match is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service key")
    name, entry = match
    if scope not in (entry.get("scopes") or []):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Service key lacks scope")
    # Admin-wide READ view on the routes that accept it; those routes are GETs, so the key can never write anything.
    return Principal(user_id=None, role=Role.marketing_admin, service=name)


def read_roles(*roles: Role, scope: str = SERVICE_READ_SCOPE):
    """require_roles for a GET route that a service may also read with X-Service-Key holding `scope`. Use it ONLY on
    read-only routes."""
    def checker(x_service_key: str | None = Header(default=None), creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                db: Session = Depends(get_db)) -> Principal:
        if x_service_key is not None:
            return service_principal(x_service_key, scope)
        p = current_principal(creds, db)
        if p.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return p

    return checker


ADMIN = (Role.marketing_admin,)
SALES = (Role.marketing_admin, Role.salesperson)
ONBOARDING = (Role.marketing_admin, Role.onboarding_agent)
ANY_ROLE = (Role.marketing_admin, Role.salesperson, Role.onboarding_agent)
