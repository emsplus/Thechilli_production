"""Access tokens + rotating refresh tokens.

A login starts a token *family*. Each refresh revokes the presented token (reason `rotated`, `replaced_by` = its
successor) and issues a new pair in the same family, with a fresh (sliding) expiry. The presented token's row is
locked FOR UPDATE, so two concurrent refreshes with the same token are serialized and only the first succeeds.

Replaying an already-rotated token is treated as theft and revokes the whole family, EXCEPT within a short grace
window (`refresh_reuse_grace_seconds`) after the rotation: two tabs/requests that raced with the same token then get
409 and nothing is revoked or issued (the client re-reads the newest token that the winner stored). The grace
window never hands out tokens, so an attacker replaying inside it gains nothing.
"""
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token, hash_refresh_token, new_refresh_token
from app.core.tenancy import bind_tenant
from app.models.core import RefreshToken, User
from app.schemas.common import TokenOut
from app.services import audit


def _now() -> datetime:
    return datetime.now(timezone.utc)


def issue_pair(db: Session, user: User, device_label: str | None = None,
               family_id: uuid.UUID | None = None, login_device_id: uuid.UUID | None = None) -> tuple[RefreshToken, TokenOut]:
    """Adds a refresh token row (caller commits) and returns it with the token pair. `login_device_id` ties the token to the
    signed-in device (services/devices.py), so revoking that device revokes this token family."""
    if family_id is None:  # new login: housekeeping of this user's long-dead tokens
        db.execute(delete(RefreshToken).where(RefreshToken.user_id == user.id,
                                              RefreshToken.expires_at < _now() - timedelta(days=1)))
    token, digest = new_refresh_token()
    rt = RefreshToken(user_id=user.id, restaurant_id=user.restaurant_id, family_id=family_id or uuid.uuid4(),
                      token_hash=digest, expires_at=_now() + timedelta(days=settings.refresh_token_days),
                      device_label=(device_label or None) and device_label[:200], login_device_id=login_device_id)
    db.add(rt)
    db.flush()
    return rt, TokenOut(access_token=create_access_token(str(user.id), str(user.restaurant_id), user.role.value),
                        refresh_token=token, expires_in=settings.access_token_minutes * 60)


def _revoke(db: Session, reason: str, *where) -> None:
    db.execute(update(RefreshToken).where(RefreshToken.revoked_at.is_(None), *where)
               .values(revoked_at=_now(), revoked_reason=reason))


def revoke_user(db: Session, user_id: uuid.UUID, reason: str, cut_access: bool = True) -> None:
    """Revokes every live refresh token of a user (password change, deactivation) and ends the user's counter PIN sessions.
    Caller commits.

    cut_access (security review finding 11): also refuse every access token issued so far (users.sessions_valid_after, to
    the whole second because a JWT iat has whole seconds), so a stolen access token dies with a password reset instead of
    living out its lifetime. Off only for the user's own password change, where the caller's session continues until it
    next refreshes."""
    _revoke(db, reason, RefreshToken.user_id == user_id)
    from app.models.devices import StaffPinSession
    db.execute(update(StaffPinSession).where(StaffPinSession.user_id == user_id, StaffPinSession.ended_at.is_(None))
               .values(ended_at=_now(), end_reason=reason[:30]))
    if cut_access:
        u = db.get(User, user_id)
        if u is not None:
            u.sessions_valid_after = _now().replace(microsecond=0)


def revoke_device(db: Session, login_device_id: uuid.UUID, reason: str = "device_revoked") -> int:
    """Revokes every live refresh token issued to one signed-in device. Caller commits. Returns how many were revoked."""
    return db.execute(update(RefreshToken).where(RefreshToken.revoked_at.is_(None), RefreshToken.login_device_id == login_device_id)
                      .values(revoked_at=_now(), revoked_reason=reason)).rowcount


def _bind_token_tenant(db: Session, digest: str) -> bool:
    """Binds the session to the refresh token's tenant (SECURITY DEFINER lookup by hash: the tenant is not known yet)."""
    tenant = db.scalar(select(func.auth_refresh_tenant(digest)))
    if tenant is None:
        return False
    bind_tenant(db, tenant)
    return True


def refresh(db: Session, token: str, device_label: str | None = None, ip: str | None = None) -> TokenOut:
    if not _bind_token_tenant(db, hash_refresh_token(token)):
        db.rollback()
        raise HTTPException(401, "Invalid refresh token")
    rt = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(token))
                   .with_for_update())
    if not rt:
        raise HTTPException(401, "Invalid refresh token")
    now = _now()
    if rt.revoked_at is not None:
        if rt.revoked_reason == "rotated":
            if now - rt.revoked_at <= timedelta(seconds=settings.refresh_reuse_grace_seconds):
                db.rollback()
                raise HTTPException(409, "Refresh token was already rotated by a concurrent request")
            _revoke(db, "reuse_detected", RefreshToken.family_id == rt.family_id)
            audit.record(db, SimpleNamespace(restaurant_id=rt.restaurant_id, user_id=rt.user_id),
                         "auth.refresh_reuse", "user", rt.user_id, {"family_id": str(rt.family_id)})
            db.commit()
            raise HTTPException(401, "Refresh token reuse detected; please sign in again")
        db.rollback()
        raise HTTPException(401, "Refresh token revoked")
    if rt.expires_at <= now:
        db.rollback()
        raise HTTPException(401, "Refresh token expired")
    user = db.get(User, rt.user_id)
    if not user or not user.is_active or user.restaurant_id != rt.restaurant_id:
        db.rollback()
        raise HTTPException(401, "Invalid user")
    new, out = issue_pair(db, user, device_label or rt.device_label, family_id=rt.family_id, login_device_id=rt.login_device_id)
    rt.revoked_at, rt.revoked_reason, rt.replaced_by = now, "rotated", new.id
    if rt.login_device_id is not None:  # the device is in use: last seen / IP for the Devices page
        from app.services import devices
        devices.seen(db, rt.login_device_id, ip)
    db.commit()
    return out


def logout(db: Session, token: str) -> None:
    """Revokes the presented token's whole family (this device's session). Unknown tokens are ignored."""
    if not _bind_token_tenant(db, hash_refresh_token(token)):
        db.rollback()
        return
    rt = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(token)))
    if rt:
        _revoke(db, "logout", RefreshToken.family_id == rt.family_id)
        db.commit()
