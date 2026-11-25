import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import to_dict
from app.core import errors
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import Principal, client_ip, current_staff
from app.core.permissions import ROLE_PERMISSIONS
from app.core.security import (DUMMY_HASH, MIN_PASSWORD_LEN, create_mfa_token, create_staff_token, get_keyring, hash_password,
                               new_opaque_token, sha256, verify_password)
from app.models import LoginAttempt, RefreshToken, StaffMfa, StaffUser, utcnow
from app.services.audit import audit, security_event

router = APIRouter(tags=["auth"])
well_known = APIRouter(tags=["auth"])


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


def check_password_policy(pw: str) -> None:
    if len(pw) < MIN_PASSWORD_LEN or pw.lower() == pw or not any(c.isdigit() for c in pw):
        raise errors.bad(f"Password must be at least {MIN_PASSWORD_LEN} characters with upper-case, lower-case and a digit",
                         "weak_password")


def issue_session(db: Session, user: StaffUser, request: Request, family: uuid.UUID | None = None, mfa: bool = False) -> dict:
    """Starts (or, with `family`, rotates) a session: refresh token + access token. Family id = session id."""
    raw, h = new_opaque_token()
    family = family or uuid.uuid4()
    db.add(RefreshToken(staff_id=user.id, family_id=family, token_hash=h, ip=client_ip(request), mfa=mfa,
                        user_agent=(request.headers.get("user-agent") or "")[:300] or None,
                        expires_at=utcnow() + timedelta(days=settings.refresh_token_days)))
    return {"access_token": create_staff_token(str(user.id), user.role, sorted(ROLE_PERMISSIONS[user.role]), str(family), mfa),
            "refresh_token": raw, "token_type": "bearer", "expires_in": settings.access_token_minutes * 60,
            "must_change_password": user.must_change_password, "mfa": mfa}


def commit_session(db: Session, out: dict) -> dict:
    """Commit BEFORE the tokens leave: get_db commits only after the response is sent, so a client using a fresh access
    token at once could otherwise find no session row yet (401 "Session ended", PORTAL_A_GAPS finding 2)."""
    db.commit()
    return out


def _backoff(n: int, free: int, base: int, cap: int) -> int:
    """Seconds to wait after the n-th consecutive failure: 0 below `free` failures, then base, 2*base, ... <= cap."""
    return 0 if n < free else min(cap, base * 2 ** min(n - free, 20))


def _retry_after(db: Session, email: str, ip: str) -> int:
    """Seconds the caller must still wait (0 = may try). Per-email protection is a progressive delay scoped to the
    (email, ip) pair, so someone hammering an admin's address cannot lock the admin out from their own network. A
    distributed attack on one email hits a capped global brake; the per-IP hard cap bounds any single source."""
    now = utcnow()
    since = now - timedelta(minutes=settings.login_window_minutes)
    last_ok = db.scalar(select(func.max(LoginAttempt.at)).where(LoginAttempt.email == email, LoginAttempt.success.is_(True)))
    start = max(since, last_ok) if last_ok else since
    base = (LoginAttempt.email == email, LoginAttempt.success.is_(False), LoginAttempt.at > start)
    n_pair, last_pair = db.execute(select(func.count(), func.max(LoginAttempt.at)).where(*base, LoginAttempt.ip == ip)).one()
    n_all, last_all = db.execute(select(func.count(), func.max(LoginAttempt.at)).where(*base)).one()
    n_ip = db.scalar(select(func.count()).where(LoginAttempt.ip == ip, LoginAttempt.success.is_(False), LoginAttempt.at > since))
    waits = []
    d = _backoff(n_pair, settings.login_max_attempts_email, settings.login_delay_base_seconds, settings.login_delay_max_seconds)
    if d and last_pair:
        waits.append(d - (now - last_pair).total_seconds())
    if n_all > settings.login_max_attempts_email_global and last_all:
        waits.append(settings.login_global_delay_seconds - (now - last_all).total_seconds())
    if n_ip >= settings.login_max_attempts_ip:
        waits.append(settings.login_window_minutes * 60)
    return max(1, int(max(waits) + 0.999)) if waits and max(waits) > 0 else 0


@router.post("/auth/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    email, ip = body.email.lower(), client_ip(request)
    wait = _retry_after(db, email, ip)
    if wait:
        security_event(db, "login_locked_out", "warn", email=email, ip=ip)
        db.commit()
        raise errors.AppError(429, "rate_limited", "Too many failed sign-in attempts. Try again later.",
                              {"Retry-After": str(wait)})
    user = db.scalar(select(StaffUser).where(StaffUser.email == email))
    good = verify_password(body.password, user.password_hash if user else DUMMY_HASH) and user is not None and user.is_active
    db.add(LoginAttempt(email=email, ip=ip, success=bool(good)))
    if not good:
        security_event(db, "login_failed", "warn", staff_id=user.id if user else None, email=email, ip=ip)
        db.commit()  # persist the failure (and thereby the rate limit) before raising
        raise errors.unauthorized("Invalid email or password")
    mfa_row = db.get(StaffMfa, user.id)
    if mfa_row is not None and mfa_row.confirmed_at is not None:
        security_event(db, "login_password_ok_mfa_pending", staff_id=user.id, email=email, ip=ip)
        return {"mfa_required": True, "mfa_token": create_mfa_token(str(user.id), "verify"),
                "expires_in": settings.mfa_challenge_minutes * 60}
    if user.role in settings.mfa_roles:  # mandatory for this role but not set up yet: the only way forward is enrolment
        security_event(db, "login_password_ok_mfa_enrolment_required", staff_id=user.id, email=email, ip=ip)
        return {"mfa_enrolment_required": True, "mfa_token": create_mfa_token(str(user.id), "enrol"),
                "expires_in": settings.mfa_challenge_minutes * 60}
    user.last_login_at = utcnow()
    security_event(db, "login_success", staff_id=user.id, email=email, ip=ip)
    return commit_session(db, issue_session(db, user, request))


@router.post("/auth/refresh")
def refresh(body: RefreshIn, request: Request, db: Session = Depends(get_db)):
    ip = client_ip(request)
    rt = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(body.refresh_token)).with_for_update())
    if rt is None or rt.expires_at < utcnow():
        raise errors.unauthorized("Invalid refresh token")
    if rt.revoked_at is not None:
        if (utcnow() - rt.revoked_at).total_seconds() > settings.refresh_reuse_grace_seconds:
            # a rotated-out token came back: assume theft, kill the whole family
            for t in db.scalars(select(RefreshToken).where(RefreshToken.family_id == rt.family_id,
                                                           RefreshToken.revoked_at.is_(None))):
                t.revoked_at = utcnow()
            security_event(db, "refresh_token_reuse", "critical", staff_id=rt.staff_id, ip=ip)
            db.commit()
        raise errors.unauthorized("Invalid refresh token")
    user = db.get(StaffUser, rt.staff_id)
    if user is None or not user.is_active:
        raise errors.unauthorized()
    if user.role in settings.mfa_roles and not rt.mfa:
        raise errors.unauthorized("Multi-factor authentication required")
    rt.revoked_at = utcnow()
    return commit_session(db, issue_session(db, user, request, rt.family_id, rt.mfa))


@router.post("/auth/logout")
def logout(body: RefreshIn, request: Request, db: Session = Depends(get_db)):
    rt = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(body.refresh_token)))
    if rt:
        for t in db.scalars(select(RefreshToken).where(RefreshToken.family_id == rt.family_id, RefreshToken.revoked_at.is_(None))):
            t.revoked_at = utcnow()
    return {"ok": True}


@router.get("/auth/me")
def me(p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    u = db.get(StaffUser, p.id)
    return {**to_dict(u), "permissions": sorted(p.permissions)}


@router.post("/auth/change-password")
def change_password(body: ChangePasswordIn, p: Principal = Depends(current_staff), db: Session = Depends(get_db)):
    u = db.get(StaffUser, p.id)
    if not verify_password(body.current_password, u.password_hash):
        raise errors.bad("Current password is incorrect", "bad_password")
    check_password_policy(body.new_password)
    u.password_hash, u.must_change_password = hash_password(body.new_password), False
    for t in db.scalars(select(RefreshToken).where(RefreshToken.staff_id == u.id, RefreshToken.revoked_at.is_(None))):
        t.revoked_at = utcnow()
    audit(db, p, "staff.password_changed", "staff_user", u.id)
    security_event(db, "password_changed", staff_id=u.id, email=u.email, ip=p.ip)
    return {"ok": True}


@router.get("/.well-known/jwks.json")
@well_known.get("/.well-known/jwks.json")
def jwks(response: Response):
    """Public keys (all keys in the ring, incl. retired ones whose tokens may still be live) for other services."""
    response.headers["Cache-Control"] = "public, max-age=300"
    return get_keyring().jwks()
