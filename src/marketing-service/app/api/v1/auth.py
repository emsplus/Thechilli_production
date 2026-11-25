import math
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.api.deps import Principal, current_principal
from app.core.config import settings
from app.core.db import get_db
from app.core.security import (create_access_token, hash_password, hash_token, new_opaque_token, utcnow,
                               verify_password)
from app.models import LoginAttempt, MarketingUser, RefreshToken
from app.schemas.api import ChangePasswordIn, LoginIn, RefreshIn, TokenOut, UserOut
from app.services import audit

router = APIRouter(prefix="/auth", tags=["auth"])

# Verified against when the email is unknown, so response time does not reveal whether an account exists.
_DUMMY_HASH = hash_password("not-a-real-password")


def _issue(db: Session, user: MarketingUser) -> TokenOut:
    raw, digest = new_opaque_token()
    db.add(RefreshToken(user_id=user.id, token_hash=digest, expires_at=utcnow() + timedelta(days=settings.refresh_token_days)))
    return TokenOut(access_token=create_access_token(str(user.id), user.role.value), refresh_token=raw)


def _client_ip(request: Request) -> str:
    return ((request.client.host if request.client else None) or "unknown")[:64]


def _retry_after(db: Session, email: str, ip: str) -> int:
    """Seconds the caller must wait (0 = may try). Three budgets, see Settings.login_* (security review finding 4)."""
    now = utcnow()
    since = now - timedelta(minutes=settings.login_window_minutes)
    window = timedelta(minutes=settings.login_window_minutes).total_seconds()

    def nth_wait(cond, n: int) -> float:
        nth = db.scalar(select(LoginAttempt.at).where(cond, LoginAttempt.at >= since)
                        .order_by(LoginAttempt.at.desc()).offset(n - 1).limit(1))
        return 0 if nth is None else window - (now - nth).total_seconds()

    waits = [nth_wait((LoginAttempt.email == email) & (LoginAttempt.ip == ip), settings.login_max_attempts),
             nth_wait(LoginAttempt.ip == ip, settings.login_max_attempts_ip)]
    n_all, last_all = db.execute(select(func.count(), func.max(LoginAttempt.at))
                                 .where(LoginAttempt.email == email, LoginAttempt.at >= since)).one()
    if n_all > settings.login_max_attempts_email_global and last_all is not None:
        waits.append(settings.login_email_global_delay_seconds - (now - last_all).total_seconds())
    worst = max(waits)
    return max(1, math.ceil(worst)) if worst > 0 else 0


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    email, ip = body.email.lower(), _client_ip(request)
    since = utcnow() - timedelta(minutes=settings.login_window_minutes)
    db.execute(delete(LoginAttempt).where(LoginAttempt.at < since))
    wait = _retry_after(db, email, ip)
    if wait:
        db.commit()
        raise HTTPException(429, "Too many failed sign-in attempts; try again later", headers={"Retry-After": str(wait)})
    user = db.scalar(select(MarketingUser).where(MarketingUser.email == email))
    ok = verify_password(body.password, user.password_hash if user else _DUMMY_HASH)
    if not user or not ok or not user.is_active:
        db.add(LoginAttempt(email=email, ip=ip))
        db.commit()
        raise HTTPException(401, "Invalid email or password")
    db.execute(delete(LoginAttempt).where(LoginAttempt.email == email))
    tokens = _issue(db, user)
    audit.record(db, user.id, "auth.login", "marketing_user", user.id)
    db.commit()
    return tokens


@router.post("/refresh", response_model=TokenOut)
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    rt = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(body.refresh_token)).with_for_update())
    if not rt:
        raise HTTPException(401, "Invalid refresh token")
    if rt.revoked_at is not None:
        # Replay of a rotated token. Within the grace window it is a benign race; otherwise assume theft and
        # revoke every live session of the user.
        if (utcnow() - rt.revoked_at).total_seconds() > settings.refresh_reuse_grace_seconds:
            db.execute(update(RefreshToken).where(RefreshToken.user_id == rt.user_id, RefreshToken.revoked_at.is_(None))
                       .values(revoked_at=utcnow()))
            audit.record(db, rt.user_id, "auth.refresh_reuse_detected", "marketing_user", rt.user_id)
            db.commit()
        raise HTTPException(401, "Invalid refresh token")
    user = db.get(MarketingUser, rt.user_id)
    if rt.expires_at <= utcnow() or not user or not user.is_active:
        raise HTTPException(401, "Invalid refresh token")
    rt.revoked_at = utcnow()
    tokens = _issue(db, user)
    db.commit()
    return tokens


@router.post("/logout", status_code=204)
def logout(body: RefreshIn, db: Session = Depends(get_db)):
    rt = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(body.refresh_token)))
    if rt and rt.revoked_at is None:
        rt.revoked_at = utcnow()
        db.commit()


@router.get("/me", response_model=UserOut)
def me(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return db.get(MarketingUser, p.user_id)


@router.post("/change-password", status_code=204)
def change_password(body: ChangePasswordIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    user = db.get(MarketingUser, p.user_id)
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    db.execute(update(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
               .values(revoked_at=utcnow()))
    audit.record(db, user.id, "auth.password_changed", "marketing_user", user.id)
    db.commit()
