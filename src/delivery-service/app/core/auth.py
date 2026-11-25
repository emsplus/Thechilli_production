"""Verifies a signed link/service token AND binds the request's DB session to the tenant it names, so the database
(Row Level Security) and the application's explicit restaurant_id filters agree on who the caller is. Also enforces
individual revocation (jti)."""
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import Unauthorized
from app.core.security import read_link_token
from app.core.tenancy import bind_tenant
from app.models import RevokedToken


def authorize(db: Session, token: str, aud: str) -> dict:
    claims = read_link_token(token, aud)
    tenant = str(claims.get("tid") or claims.get("rid") or "").strip()
    if not tenant or len(tenant) > 64:
        raise Unauthorized("token carries no tenant", code="bad_token")
    bind_tenant(db, tenant)
    jti = claims.get("jti")
    if jti and db.get(RevokedToken, (tenant, jti)):
        raise Unauthorized("token revoked", code="token_revoked")
    return claims


def revoke(db: Session, tenant: str, claims: dict, reason: str = "") -> bool:
    """Revokes one token of `tenant` (already verified). False if it carries no jti (legacy token: rotate the key)."""
    jti = claims.get("jti")
    if not jti:
        return False
    try:
        with db.begin_nested():
            db.add(RevokedToken(restaurant_id=tenant, jti=jti, aud=str(claims.get("aud", ""))[:16],
                                expires_at=datetime.fromtimestamp(claims["exp"], UTC), reason=reason[:200]))
    except IntegrityError:
        pass  # already revoked
    return True


def purge_expired(db: Session, tenant: str) -> int:
    rows = db.scalars(select(RevokedToken).where(RevokedToken.restaurant_id == tenant,
                                                 RevokedToken.expires_at < datetime.now(UTC))).all()
    for r in rows:
        db.delete(r)
    return len(rows)
