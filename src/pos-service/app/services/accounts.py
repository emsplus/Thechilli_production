"""Login throttling, credential matching across restaurants, and account lifecycle (password change / reset,
deactivate / reactivate)."""
import math
import uuid
from dataclasses import dataclass
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.core import password_policy
from app.core.config import settings
from app.core.security import hash_password, verify_password
from app.core.tenancy import tenant_session
from app.models.core import LoginAttempt, Restaurant, Role, User
from app.services import audit, staff_accounts, tokens

_CANDIDATES = text("SELECT user_id, restaurant_id FROM auth_login_candidates(:e, CAST(:r AS uuid))")
_DUMMY_HASH = hash_password("dummy-password-for-timing")


@dataclass(frozen=True)
class LoginMatch:
    user_id: uuid.UUID
    restaurant_id: uuid.UUID
    restaurant_name: str
    role: str


def candidates(db: Session, email: str, restaurant_id: uuid.UUID | None = None) -> list:
    """(user_id, restaurant_id) of every account holding this email (case-insensitive), at most 10. Ids only."""
    return db.execute(_CANDIDATES, {"e": email.strip(), "r": str(restaurant_id) if restaurant_id else None}).all()


def password_matches(db: Session, email: str, password: str, restaurant_id: uuid.UUID | None = None) -> list[LoginMatch]:
    """The ACTIVE accounts with this email whose password is `password` (security review finding 1).

    The password is checked against every candidate BEFORE anything is said about how many accounts exist, so a wrong
    password always gets the same answer (no enumeration through a 'several restaurants' reply), and a second account that
    holds someone's email (another tenant registered or invited it) can never lock that person out: it only matters when
    its password is the same. Each candidate is loaded in its own tenant-bound session (RLS); at least one hash is always
    verified so unknown emails take about as long as known ones."""
    found = candidates(db, email, restaurant_id)
    out: list[LoginMatch] = []
    if not found:
        verify_password(password, _DUMMY_HASH)
        return out
    for c in found:
        with tenant_session(c.restaurant_id) as t:
            u = t.get(User, c.user_id)
            rest = t.get(Restaurant, c.restaurant_id)
            if u is None or rest is None:
                continue
            ok = verify_password(password, u.password_hash)
            if ok and u.is_active:
                out.append(LoginMatch(u.id, rest.id, rest.name, u.role.value if hasattr(u.role, "value") else str(u.role)))
    return out


def _window() -> timedelta:
    return timedelta(minutes=settings.login_window_minutes)


def throttle_key(email: str) -> str:
    return email.strip().lower()


def client_ip(request) -> str:
    """The client address uvicorn reports (X-Forwarded-For counts only from FORWARDED_ALLOW_IPS peers)."""
    return ((request.client.host if request is not None and request.client else None) or "unknown")[:64]


def _nth_wait(db: Session, cond, n: int) -> float:
    """Seconds until fewer than `n` failures matching `cond` remain in the window (0 = fewer than n now). The n-th most
    recent failure decides when the count drops below the limit again."""
    nth = db.scalar(select(LoginAttempt.created_at).where(cond, LoginAttempt.created_at > func.now() - _window())
                    .order_by(LoginAttempt.created_at.desc()).offset(n - 1).limit(1))
    if nth is None:
        return 0
    now = db.scalar(select(func.clock_timestamp()))
    return (nth + _window() - now).total_seconds()


def retry_after(db: Session, email: str, ip: str = "unknown") -> int:
    """Seconds until another attempt is allowed, 0 if allowed now (security review finding 4). Keyed on the email whether
    or not an account exists, so unknown emails are throttled identically and nothing is revealed. Three budgets (see
    Settings.login_*): the (email, IP) pair, the IP across all emails, and a softer brake on the email across all IPs."""
    waits = [
        _nth_wait(db, (LoginAttempt.email == email) & (LoginAttempt.ip == ip), settings.login_max_attempts),
        _nth_wait(db, LoginAttempt.ip == ip, settings.login_max_attempts_ip),
    ]
    n_all, last_all = db.execute(select(func.count(), func.max(LoginAttempt.created_at)).where(
        LoginAttempt.email == email, LoginAttempt.created_at > func.now() - _window())).one()
    if n_all > settings.login_max_attempts_email_global and last_all is not None:
        now = db.scalar(select(func.clock_timestamp()))
        waits.append(settings.login_email_global_delay_seconds - (now - last_all).total_seconds())
    worst = max(waits)
    return max(1, math.ceil(worst)) if worst > 0 else 0


def record_failure(db: Session, email: str, ip: str = "unknown") -> None:
    db.execute(delete(LoginAttempt).where(LoginAttempt.created_at < func.now() - _window()))  # housekeeping
    db.add(LoginAttempt(email=email, ip=ip))
    db.commit()


def clear_failures(db: Session, email: str) -> None:
    """After a success: the email's failures from every IP (the IP-wide count of other emails stays)."""
    db.execute(delete(LoginAttempt).where(LoginAttempt.email == email))
    db.commit()


def change_password(db: Session, p, current: str, new: str, ip: str = "unknown") -> None:
    u = db.get(User, p.user_id)
    key = staff_accounts.throttle_key_of(u)  # shares the login budget: a stolen token cannot brute-force the password
    wait = retry_after(db, key, ip)
    if wait:
        raise HTTPException(429, "Too many failed attempts. Try again later.", headers={"Retry-After": str(wait)})
    if not verify_password(current, u.password_hash):
        record_failure(db, key, ip)
        raise HTTPException(403, "Current password is incorrect")
    if current == new:
        raise HTTPException(422, "New password must differ from the current one")
    password_policy.enforce(new, u.email, u.full_name)  # security review finding 7
    u.password_hash = hash_password(new)
    u.must_change_password = False
    db.execute(delete(LoginAttempt).where(LoginAttempt.email == key))
    tokens.revoke_user(db, u.id, "password_change", cut_access=False)  # every device must sign in with the new password
    audit.record(db, p, "auth.password_change", "user", u.id)
    db.commit()


def set_active(db: Session, p, user_id: uuid.UUID, active: bool) -> User:
    """Owner-only (enforced by the route). Idempotent. Existing access tokens stop working immediately because
    deps.current_principal re-reads is_active on every request; refresh tokens are revoked on deactivation."""
    # Lock all owners of the tenant in a stable order so two owners cannot deactivate each other concurrently.
    owners = db.scalars(select(User).where(User.restaurant_id == p.restaurant_id, User.role == Role.owner)
                        .order_by(User.id).with_for_update()
                        .execution_options(populate_existing=True)).all()  # re-read: the principal's row may be stale after the lock wait
    target = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id)
                       .with_for_update())
    if not target:
        raise HTTPException(404, "User not found")
    staff_accounts.require_can_manage(db, p, target, "reactivate" if active else "deactivate")
    if target.is_active == active:
        return target
    if not active:
        if target.id == p.user_id:
            raise HTTPException(409, "You cannot deactivate yourself")
        if target.role == Role.owner and not any(o.is_active and o.id != target.id for o in owners):
            raise HTTPException(409, "Cannot deactivate the last active owner")
    target.is_active = active
    if not active:
        tokens.revoke_user(db, target.id, "deactivated")
    audit.record(db, p, "user.reactivate" if active else "user.deactivate", "user", target.id)
    db.commit()
    return target


def reset_password(db: Session, p, user_id: uuid.UUID, new: str) -> None:
    """Owner-only (enforced by the route). Sets a new password for another user of the same tenant, signs them out
    everywhere and clears their login throttle. Yourself: use change_password (which proves the current password)."""
    if user_id == p.user_id:
        raise HTTPException(409, "Use change password for your own account")
    target = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id)
                       .with_for_update())
    if not target:
        raise HTTPException(404, "User not found")
    staff_accounts.require_can_manage(db, p, target, "reset the password of")
    password_policy.enforce(new, target.email, target.full_name)  # security review finding 7
    target.password_hash = hash_password(new)
    target.must_change_password = True  # the owner knows it: the user chooses their own at the next sign-in
    db.execute(delete(LoginAttempt).where(LoginAttempt.email == staff_accounts.throttle_key_of(target)))
    tokens.revoke_user(db, target.id, "password_reset")
    audit.record(db, p, "user.password_reset", "user", target.id)
    db.commit()
