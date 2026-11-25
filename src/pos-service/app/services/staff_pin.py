"""Staff PINs, PIN sessions on counter devices, step-up (docs/STAFF_PIN_DEVICES_API.md).

Security properties (threat model in the doc):
* the PIN is stored only as an argon2 hash (app/core/security.hash_password: random per-hash salt), optionally peppered with
  PIN_PEPPER (HMAC-SHA256) first; verification is argon2's constant-time check, and unknown users / users without a PIN are
  verified against a dummy hash so the timing does not tell them apart;
* wrong PINs are counted per (user, counter device): PIN_MAX_FAILURES wrong -> locked PIN_LOCKOUT_MINUTES, doubling with every
  further lockout (capped), audited (`auth.pin.locked`) and passed to the lockout hooks (manager notification); and per user
  across every device (PIN_USER_FAILURES_PER_HOUR); a locked PIN is not even checked;
* POST /auth/pin-login is rate limited per client IP and per counter device (every call counts);
* the PIN never appears in a log line, an audit row or an error body (the request models use SecretStr).
"""
import hashlib
import hmac
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Callable

import jwt
from fastapi import HTTPException
from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from app.core import permissions
from app.core.config import settings
from app.core.db import SessionLocal
from app.core.security import hash_password, verify_password
from app.models.core import Role, User
from app.models.devices import CounterDevice, PinLockout, StaffPin, StaffPinSession
from app.services import abuse, accounts, audit, devices

log = logging.getLogger("app.staff_pin")

PIN_RE = re.compile(r"^[0-9]{4,6}$")
PERSONAL = "personal"  # lockout scope of step-up from the user's own (password) session
_DUMMY = hash_password("0000-dummy-pin-for-timing")
STEP_UP_AUD_SUFFIX = ":step-up"

# Manager notification hooks: called (after the commit) with a dict {restaurant_id, user_id, user_name, counter_device_id,
# scope, lock_level, locked_until}. Never contains the PIN. Exceptions are logged and swallowed.
LOCKOUT_HOOKS: list[Callable[[dict], None]] = []


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------------------------------------ hashing / validation
def _material(pin: str, peppered: bool) -> str:
    if not peppered:
        return pin
    key = settings.pin_pepper.get_secret_value().encode()
    return hmac.new(key, pin.encode(), hashlib.sha256).hexdigest()


def hash_pin(pin: str) -> tuple[str, str]:
    peppered = bool(settings.pin_pepper.get_secret_value())
    return hash_password(_material(pin, peppered)), ("argon2+pepper" if peppered else "argon2")


def _verify(pin: str, row: StaffPin | None) -> bool:
    if row is None:
        verify_password(pin, _DUMMY)  # same work as a real check
        return False
    peppered = row.scheme == "argon2+pepper"
    if peppered and not settings.pin_pepper.get_secret_value():
        verify_password(pin, _DUMMY)
        return False
    return verify_password(_material(pin, peppered), row.pin_hash)


def validate_pin(pin: str) -> str:
    """4-6 digits, not all the same digit and not a straight run (1234, 98765). 422 otherwise (the PIN is not echoed)."""
    if not PIN_RE.match(pin or ""):
        raise HTTPException(422, "PIN must be 4 to 6 digits")
    digits = [int(c) for c in pin]
    steps = {b - a for a, b in zip(digits, digits[1:])}
    if len(set(digits)) == 1 or steps in ({1}, {-1}):
        raise HTTPException(422, "PIN is too easy to guess; avoid repeated digits and sequences")
    return pin


# ------------------------------------------------------------------------------------------------ set / clear / status
def status(db: Session, user_id: uuid.UUID) -> dict:
    row = db.get(StaffPin, user_id)
    return {"is_set": row is not None, "set_at": row.set_at if row else None,
            "set_by_manager": bool(row and row.set_by_manager)}


def _store(db: Session, target: User, pin: str, by: uuid.UUID, by_manager: bool) -> None:
    h, scheme = hash_pin(validate_pin(pin))
    row = db.get(StaffPin, target.id)
    if row is None:
        row = StaffPin(user_id=target.id, restaurant_id=target.restaurant_id)
        db.add(row)
    row.pin_hash, row.scheme, row.set_by, row.set_by_manager, row.set_at = h, scheme, by, by_manager, _now()
    _clear_locks(db, target.id)
    _end_sessions(db, target.id, "pin_changed")


def _clear_locks(db: Session, user_id: uuid.UUID) -> None:
    db.execute(delete(PinLockout).where(PinLockout.user_id == user_id))
    with SessionLocal() as s:  # the cross-device counter lives in abuse_counters (no tenant)
        s.execute(text("DELETE FROM abuse_counters WHERE key = :k"), {"k": _user_key(user_id)})
        s.commit()


def _end_sessions(db: Session, user_id: uuid.UUID, reason: str) -> int:
    return db.execute(update(StaffPinSession).where(StaffPinSession.user_id == user_id, StaffPinSession.ended_at.is_(None))
                      .values(ended_at=_now(), end_reason=reason)).rowcount


def set_own(db: Session, p, pin: str, current_password: str) -> None:
    """A user sets / changes their own PIN from a PASSWORD session, re-entering the password (shares the login throttle)."""
    if getattr(p, "pin_session", None):
        raise HTTPException(403, "Set your PIN after signing in with your password")
    u = db.get(User, p.user_id)
    key = accounts.throttle_key(u.email)
    wait = accounts.retry_after(db, key)
    if wait:
        raise HTTPException(429, "Too many failed attempts. Try again later.", headers={"Retry-After": str(wait)})
    if not verify_password(current_password, u.password_hash):
        accounts.record_failure(db, key)
        raise HTTPException(403, "Current password is incorrect")
    _store(db, u, pin, p.user_id, False)
    audit.record(db, p, "auth.pin.set", "user", u.id, {"by": "self"})
    db.commit()


def clear_own(db: Session, p) -> None:
    if getattr(p, "pin_session", None):
        raise HTTPException(403, "Remove your PIN after signing in with your password")
    db.execute(delete(StaffPin).where(StaffPin.user_id == p.user_id))
    _end_sessions(db, p.user_id, "pin_changed")
    _clear_locks(db, p.user_id)
    audit.record(db, p, "auth.pin.clear", "user", p.user_id, {"by": "self"})
    db.commit()


def _target(db: Session, p, user_id: uuid.UUID) -> User:
    u = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id))
    if u is None:
        raise HTTPException(404, "User not found")
    if u.role == Role.owner and u.id != p.user_id and not permissions.ALL_PERMISSIONS <= p.permissions:
        raise HTTPException(403, "Only an owner can manage an owner's PIN")
    return u


def set_for(db: Session, p, user_id: uuid.UUID, pin: str) -> None:
    """Manager reset: sets a PIN for the user (flagged set_by_manager, so the app can ask them to choose their own)."""
    u = _target(db, p, user_id)
    _store(db, u, pin, p.user_id, u.id != p.user_id)
    audit.record(db, p, "auth.pin.reset", "user", u.id, {"by": "manager"})
    db.commit()


def clear_for(db: Session, p, user_id: uuid.UUID) -> None:
    u = _target(db, p, user_id)
    db.execute(delete(StaffPin).where(StaffPin.user_id == u.id))
    _end_sessions(db, u.id, "pin_changed")
    _clear_locks(db, u.id)
    audit.record(db, p, "auth.pin.clear", "user", u.id, {"by": "manager"})
    db.commit()


def unlock(db: Session, p, user_id: uuid.UUID) -> None:
    u = _target(db, p, user_id)
    _clear_locks(db, u.id)
    audit.record(db, p, "auth.pin.unlock", "user", u.id)
    db.commit()


# ------------------------------------------------------------------------------------------------ brute force
def _user_key(user_id: uuid.UUID) -> str:
    return f"pin:user:{user_id}"


def _lock_minutes(level: int) -> int:
    return min(settings.pin_lockout_minutes * (2 ** max(0, level - 1)), settings.pin_lockout_max_minutes)


def locked_for(db: Session, user_id: uuid.UUID, scope: str) -> int:
    """Seconds until this user may try a PIN again in this scope (0 = now)."""
    now = _now()
    row = db.scalar(select(PinLockout).where(PinLockout.user_id == user_id, PinLockout.scope_key == scope))
    wait = int((row.locked_until - now).total_seconds()) + 1 if row and row.locked_until and row.locked_until > now else 0
    return max(wait, abuse.locked_for([_user_key(user_id)]))


def _fail(db: Session, user: User, scope: str, actor, device_id: uuid.UUID | None) -> tuple[int, dict | None]:
    """Counts a wrong PIN (committed). Returns (attempts left before a lockout, lockout event or None)."""
    now = _now()
    row = db.scalar(select(PinLockout).where(PinLockout.user_id == user.id, PinLockout.scope_key == scope).with_for_update())
    if row is None:
        row = PinLockout(restaurant_id=user.restaurant_id, user_id=user.id, scope_key=scope, failures=0, lock_level=0)
        db.add(row)
    row.failures, row.last_failure_at = (row.failures or 0) + 1, now
    event = None
    audit.record(db, actor, "auth.pin.failed", "user", user.id,
                 {"scope": scope, "counter_device_id": str(device_id) if device_id else None, "failures": row.failures})
    if row.failures >= settings.pin_max_failures:
        row.lock_level = (row.lock_level or 0) + 1
        row.locked_until, row.failures = now + timedelta(minutes=_lock_minutes(row.lock_level)), 0
        event = {"restaurant_id": str(user.restaurant_id), "user_id": str(user.id), "user_name": user.full_name,
                 "counter_device_id": str(device_id) if device_id else None, "scope": scope, "lock_level": row.lock_level,
                 "locked_until": row.locked_until.isoformat()}
        audit.record(db, actor, "auth.pin.locked", "user", user.id,
                     {k: event[k] for k in ("scope", "counter_device_id", "lock_level", "locked_until")})
    left = settings.pin_max_failures - row.failures if event is None else 0
    db.commit()
    # across devices: many wrong PINs for one user anywhere lock that user everywhere for an hour
    n = abuse.hit(_user_key(user.id), window=timedelta(hours=1), limit=settings.pin_user_failures_per_hour, lockout=timedelta(hours=1))
    if n == settings.pin_user_failures_per_hour and event is None:
        event = {"restaurant_id": str(user.restaurant_id), "user_id": str(user.id), "user_name": user.full_name,
                 "counter_device_id": str(device_id) if device_id else None, "scope": "all_devices", "lock_level": None,
                 "locked_until": (now + timedelta(hours=1)).isoformat()}
    if event:
        notify_lockout(event)
    return left, event


def notify_lockout(event: dict) -> None:
    log.warning("staff PIN locked: tenant=%s user=%s device=%s scope=%s level=%s until=%s", event["restaurant_id"],
                event["user_id"], event["counter_device_id"], event["scope"], event["lock_level"], event["locked_until"])
    for hook in list(LOCKOUT_HOOKS):
        try:
            hook(dict(event))
        except Exception:  # noqa: BLE001  a notification must never break sign-in
            log.exception("PIN lockout hook failed")


def _success(db: Session, user_id: uuid.UUID, scope: str) -> None:
    db.execute(delete(PinLockout).where(PinLockout.user_id == user_id, PinLockout.scope_key == scope))


def check_pin(db: Session, user: User | None, pin: str, scope: str, actor, device_id: uuid.UUID | None) -> None:
    """Verifies `pin` for `user` in a lockout scope, or raises 429 (locked) / 401 (wrong). Never verifies a locked PIN."""
    if user is not None:
        wait = locked_for(db, user.id, scope)
        if wait:
            raise HTTPException(429, "Too many wrong PINs. Try again later or ask a manager to unlock.",
                                headers={"Retry-After": str(wait)})
    row = db.get(StaffPin, user.id) if user is not None else None
    if row is not None and row.restaurant_id != user.restaurant_id:
        row = None
    ok = _verify(pin, row)
    if not ok:
        if user is None or row is None:  # unknown user / no PIN: same answer, nothing to count against
            raise HTTPException(401, "Wrong PIN")
        left, event = _fail(db, user, scope, actor, device_id)
        if event is not None:
            raise HTTPException(429, "Too many wrong PINs. Try again later or ask a manager to unlock.",
                                headers={"Retry-After": str(locked_for(db, user.id, scope))})
        raise HTTPException(401, "Wrong PIN", headers={"X-Pin-Attempts-Left": str(left)})
    _success(db, user.id, scope)


# ------------------------------------------------------------------------------------------------ PIN sessions
def _jwt(claims: dict, minutes: float, aud: str) -> tuple[str, datetime]:
    now = _now()
    exp = now + timedelta(minutes=minutes)
    tok = jwt.encode({**claims, "iat": now, "exp": exp, "iss": settings.jwt_issuer, "aud": aud},
                     settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return tok, exp


def excluded_permissions() -> frozenset[str]:
    return frozenset(x.strip() for x in settings.pin_session_excluded_permissions.split(",") if x.strip())


def pin_login(db: Session, device_token: str, user_id: uuid.UUID, pin: str, ip: str) -> dict:
    abuse.throttle([(f"pinlogin:ip:{ip}", settings.pin_login_per_ip_per_10min)], window=timedelta(minutes=10),
                   what="PIN sign-in attempts")
    d = devices.authenticate_counter(db, device_token, ip)
    abuse.throttle([(f"pinlogin:dev:{d.id}", settings.pin_login_per_device_per_10min)], window=timedelta(minutes=10),
                   what="PIN sign-in attempts on this device")
    user = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == d.restaurant_id))
    usable = user is not None and user.is_active and devices.allowed_at(db, user, d.outlet_id)
    actor = SimpleNamespace(restaurant_id=d.restaurant_id, user_id=user.id if user else None, support=None)
    check_pin(db, user if usable else None, pin, str(d.id), actor, d.id)
    now = _now()
    devices.purge(db, d.restaurant_id)
    # one staff member at a time per counter device: signing in ends whatever session the tablet had before
    db.execute(update(StaffPinSession).where(StaffPinSession.counter_device_id == d.id, StaffPinSession.ended_at.is_(None))
               .values(ended_at=now, end_reason="replaced"))
    s = StaffPinSession(restaurant_id=d.restaurant_id, outlet_id=d.outlet_id, counter_device_id=d.id, user_id=user.id,
                        started_at=now, last_activity_at=now, ip=ip[:64],
                        expires_at=now + timedelta(hours=settings.pin_session_max_hours))
    db.add(s)
    db.flush()
    pin_row = db.get(StaffPin, user.id)
    perms = permissions.resolve(db, user) - excluded_permissions()
    audit.record(db, actor, "auth.pin.login", "staff_pin_session", s.id,
                 {"counter_device_id": str(d.id), "outlet_id": str(d.outlet_id), "ip": ip})
    db.commit()
    token, _ = _jwt({"sub": str(user.id), "rid": str(user.restaurant_id), "role": user.role.value, "ps": str(s.id),
                     "typ": "pin"}, settings.pin_session_max_hours * 60, settings.jwt_audience)
    return {"access_token": token, "token_type": "bearer", "expires_in": settings.pin_session_max_hours * 3600,
            "idle_timeout_seconds": settings.pin_idle_minutes * 60, "session_id": s.id, "expires_at": s.expires_at,
            "outlet_id": d.outlet_id, "counter_device_id": d.id,
            "user": {"id": user.id, "name": user.full_name, "role": user.role.value, "initials": devices.initials(user.full_name)},
            "permissions": sorted(perms), "pin_change_suggested": bool(pin_row and pin_row.set_by_manager)}


def session_state(db: Session, session_id: uuid.UUID, user_id: uuid.UUID) -> StaffPinSession:
    """The live PIN session of a request (401 when ended, idle or expired). Slides the idle window (own short session, so it
    sticks even when the request itself never commits; at most one write per 30 seconds)."""
    s = db.get(StaffPinSession, session_id)
    now = _now()
    if s is None or s.user_id != user_id or s.ended_at is not None or s.expires_at <= now:
        raise HTTPException(401, "PIN session ended; sign in with your PIN again", headers={"X-Session-Locked": "ended"})
    if s.last_activity_at + timedelta(minutes=settings.pin_idle_minutes) <= now:
        raise HTTPException(401, "PIN session locked after inactivity; enter your PIN again", headers={"X-Session-Locked": "idle"})
    if now - s.last_activity_at > timedelta(seconds=30):
        from app.core.tenancy import tenant_session
        with tenant_session(s.restaurant_id) as w:
            w.execute(update(StaffPinSession).where(StaffPinSession.id == s.id, StaffPinSession.ended_at.is_(None))
                      .values(last_activity_at=now))
            w.commit()
        s.last_activity_at = now
    return s


def pin_logout(db: Session, claims: dict, reason: str) -> None:
    from app.core.tenancy import bind_tenant
    bind_tenant(db, claims["rid"])
    s = db.get(StaffPinSession, uuid.UUID(claims["ps"]))
    if s is None or str(s.user_id) != claims.get("sub") or s.ended_at is not None:
        return
    s.ended_at, s.end_reason = _now(), reason
    audit.record(db, SimpleNamespace(restaurant_id=s.restaurant_id, user_id=s.user_id, support=None), "auth.pin.logout",
                 "staff_pin_session", s.id, {"reason": reason, "counter_device_id": str(s.counter_device_id)})
    db.commit()


# ------------------------------------------------------------------------------------------------ step-up
def step_up(db: Session, p, pin: str | None, password: str | None) -> dict:
    """A 5-minute proof that the CURRENT user just re-entered their PIN (or password). The token's audience differs from
    access tokens, so it can never be used as a bearer token."""
    if bool(pin) == bool(password):
        raise HTTPException(422, "Give either pin or password")
    u = db.get(User, p.user_id)
    if getattr(p, "support", None) or u is None:
        raise HTTPException(403, "Step-up needs a staff session")
    ps = getattr(p, "pin_session", None)
    if pin:
        scope = str(ps["counter_device_id"]) if ps else PERSONAL
        check_pin(db, u, pin, scope, p, uuid.UUID(scope) if ps else None)
        method = "pin"
    else:
        key = accounts.throttle_key(u.email)
        wait = accounts.retry_after(db, key)
        if wait:
            raise HTTPException(429, "Too many failed attempts. Try again later.", headers={"Retry-After": str(wait)})
        if not verify_password(password, u.password_hash):
            accounts.record_failure(db, key)
            raise HTTPException(401, "Wrong password")
        method = "password"
    audit.record(db, p, "auth.step_up", "user", u.id, {"method": method})
    db.commit()
    token, exp = _jwt({"sub": str(u.id), "rid": str(u.restaurant_id), "typ": "step_up", "jti": uuid.uuid4().hex},
                      settings.step_up_minutes, settings.jwt_audience + STEP_UP_AUD_SUFFIX)
    return {"step_up_token": token, "expires_in": settings.step_up_minutes * 60, "expires_at": exp, "method": method}


def verify_step_up(token: str | None, user_id, restaurant_id) -> bool:
    if not token:
        return False
    try:
        c = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm], issuer=settings.jwt_issuer,
                       audience=settings.jwt_audience + STEP_UP_AUD_SUFFIX, options={"require": ["exp", "sub", "rid", "aud"]})
    except jwt.PyJWTError:
        return False
    return c.get("typ") == "step_up" and c.get("sub") == str(user_id) and c.get("rid") == str(restaurant_id)


def require_step_up(p, what: str) -> None:
    """STEP_UP_REQUIRED on: 403 unless the request carried a valid X-Step-Up-Token of this user. Off: nothing."""
    if settings.step_up_required and not getattr(p, "step_up", False):
        raise HTTPException(403, f"Re-enter your PIN to {what} (step-up required)", headers={"X-Step-Up-Required": "1"})
