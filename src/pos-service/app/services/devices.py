"""Device sessions and counter devices (docs/STAFF_PIN_DEVICES_API.md).

Signed-in devices: every password sign-in (login, sign-up) records the client device from its headers (X-Device-Id, X-Device-Name,
X-Device-Model, X-Device-Platform; the User-Agent when X-Device-Id is absent) and ties the refresh token to it. Revoking a
device revokes its refresh tokens at once, so the next /auth/refresh from it is a 401; access tokens already issued stay
valid until they expire (ACCESS_TOKEN_MINUTES).

Counter devices: an owner / manager registers a shared tablet for one outlet and gets a credential once. The credential is
NOT a user token: deps.current_principal refuses it (it is not a JWT), so it can only call the counter routes
(roster / menu / tables of its outlet) and POST /auth/pin-login."""
import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from fastapi import HTTPException, Request
from sqlalchemy import and_, delete, exists, func, or_, select, text, update
from sqlalchemy.orm import Session

from app.core import permissions
from app.core.config import settings
from app.core.db import SessionLocal
from app.core.permissions import P
from app.core.tenancy import bind_tenant
from app.models.core import Outlet, RefreshToken, Restaurant, Role, User
from app.models.devices import CounterDevice, LoginDevice, PinLockout, StaffPinSession
from app.services import audit, outlets, tokens

TOKEN_PREFIX = "cdt_"  # counter device token: recognisable in logs / secret scanners, never a JWT


def _now() -> datetime:
    return datetime.now(timezone.utc)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _clip(v: str | None, n: int) -> str | None:
    v = (v or "").strip()
    return v[:n] or None


@dataclass
class ClientDevice:
    key: str
    name: str | None
    model: str | None
    platform: str | None
    user_agent: str | None
    ip: str


def client_device(request: Request, label: str | None = None) -> ClientDevice:
    h = request.headers
    ua = _clip(h.get("user-agent"), 300)
    key = _clip(h.get("x-device-id"), 100)
    if key is None:  # older clients: one row per browser / app build, still listable and revocable
        key = "ua:" + hashlib.sha256((ua or "unknown").encode()).hexdigest()[:32]
    return ClientDevice(key=key, name=_clip(h.get("x-device-name"), 100) or _clip(label, 100),
                        model=_clip(h.get("x-device-model"), 100), platform=_clip(h.get("x-device-platform"), 30),
                        user_agent=ua, ip=client_ip(request)[:64])


# ------------------------------------------------------------------------------------------------ signed-in devices
def record_login(db: Session, user: User, cd: ClientDevice) -> LoginDevice:
    """Upserts the (user, device) row on a password sign-in; a new sign-in clears an earlier revocation. Caller commits."""
    now = _now()
    purge(db, user.restaurant_id)
    d = db.scalar(select(LoginDevice).where(LoginDevice.user_id == user.id, LoginDevice.device_key == cd.key).with_for_update())
    if d is None:
        d = LoginDevice(restaurant_id=user.restaurant_id, user_id=user.id, device_key=cd.key, first_seen_at=now)
        db.add(d)
    d.name = cd.name or d.name
    d.model = cd.model or d.model
    d.platform = cd.platform or d.platform
    d.user_agent = cd.user_agent or d.user_agent
    d.last_seen_at, d.last_ip, d.revoked_at, d.revoked_by = now, cd.ip, None, None
    db.flush()
    return d


def seen(db: Session, login_device_id: uuid.UUID, ip: str | None) -> None:
    vals = {"last_seen_at": _now()}
    if ip:
        vals["last_ip"] = ip[:64]
    db.execute(update(LoginDevice).where(LoginDevice.id == login_device_id).values(**vals))


def _live_token():
    return exists().where(RefreshToken.login_device_id == LoginDevice.id, RefreshToken.revoked_at.is_(None),
                          RefreshToken.expires_at > func.now())


def list_devices(db: Session, p, *, everyone: bool, user_id: uuid.UUID | None, current_key: str | None) -> list[dict]:
    if (everyone or (user_id and user_id != p.user_id)) and not p.can(P.DEVICES_MANAGE):
        raise HTTPException(403, "Insufficient permissions")
    q = (select(LoginDevice, User.full_name, User.role, _live_token().label("active"))
         .join(User, User.id == LoginDevice.user_id).where(LoginDevice.restaurant_id == p.restaurant_id))
    if user_id:
        q = q.where(LoginDevice.user_id == user_id)
    elif not everyone:
        q = q.where(LoginDevice.user_id == p.user_id)
    rows = db.execute(q.order_by(LoginDevice.last_seen_at.desc())).all()
    return [{"id": d.id, "user_id": d.user_id, "user_name": name, "user_role": role.value,
             "device_id": None if d.device_key.startswith("ua:") else d.device_key,
             "name": d.name, "model": d.model, "platform": d.platform, "user_agent": d.user_agent,
             "first_seen_at": d.first_seen_at, "last_seen_at": d.last_seen_at, "last_ip": d.last_ip,
             "revoked_at": d.revoked_at, "active": bool(active) and d.revoked_at is None,
             "current": d.user_id == p.user_id and current_key is not None and d.device_key == current_key}
            for d, name, role, active in rows]


def _check_target(db: Session, p, user_id: uuid.UUID) -> User:
    """Someone else's devices: devices.manage, and only an owner may touch an owner's devices."""
    target = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id))
    if target is None:
        raise HTTPException(404, "User not found")
    if target.id != p.user_id:
        if not p.can(P.DEVICES_MANAGE):
            raise HTTPException(404, "Device not found")  # someone else's device is simply not visible
        if target.role == Role.owner and not permissions.ALL_PERMISSIONS <= p.permissions:
            raise HTTPException(403, "Only an owner can sign an owner out")
    return target


def revoke(db: Session, p, device_id: uuid.UUID) -> None:
    d = db.scalar(select(LoginDevice).where(LoginDevice.id == device_id, LoginDevice.restaurant_id == p.restaurant_id)
                  .with_for_update())
    if d is None or (d.user_id != p.user_id and not p.can(P.DEVICES_MANAGE)):
        raise HTTPException(404, "Device not found")
    _check_target(db, p, d.user_id)
    n = tokens.revoke_device(db, d.id)
    if d.revoked_at is None:
        d.revoked_at, d.revoked_by = _now(), p.user_id
    audit.record(db, p, "auth.device.revoke", "login_device", d.id,
                 {"user_id": str(d.user_id), "name": d.name, "platform": d.platform, "tokens_revoked": n})
    db.commit()


def sign_out_all(db: Session, p, user_id: uuid.UUID, keep_key: str | None = None) -> int:
    """Revokes every refresh token of the user (except those of the device `keep_key`, the caller's own, when asked), marks
    the devices revoked and ends the user's counter PIN sessions. Returns the number of devices signed out."""
    target = _check_target(db, p, user_id)
    keep = None
    if keep_key and target.id == p.user_id:
        keep = db.scalar(select(LoginDevice.id).where(LoginDevice.user_id == target.id, LoginDevice.device_key == keep_key))
    now = _now()
    cond = [RefreshToken.user_id == target.id, RefreshToken.revoked_at.is_(None)]
    if keep is not None:
        cond.append(or_(RefreshToken.login_device_id.is_(None), RefreshToken.login_device_id != keep))
    db.execute(update(RefreshToken).where(*cond).values(revoked_at=now, revoked_reason="sign_out_all"))
    dq = [LoginDevice.user_id == target.id, LoginDevice.revoked_at.is_(None)]
    if keep is not None:
        dq.append(LoginDevice.id != keep)
    n = db.execute(update(LoginDevice).where(*dq).values(revoked_at=now, revoked_by=p.user_id)).rowcount
    s = db.execute(update(StaffPinSession).where(StaffPinSession.user_id == target.id, StaffPinSession.ended_at.is_(None))
                   .values(ended_at=now, end_reason="sign_out_all")).rowcount
    audit.record(db, p, "auth.sign_out_all", "user", target.id,
                 {"devices": n, "pin_sessions": s, "kept_current_device": keep is not None})
    db.commit()
    return n


def purge(db: Session, restaurant_id: uuid.UUID) -> None:
    """Retention (runs on sign-in, for the signing-in tenant only): signed-in devices unseen for DEVICE_RETENTION_DAYS with no
    live refresh token, PIN sessions ended / expired more than PIN_SESSION_RETENTION_DAYS ago, stale PIN lockout rows."""
    now = _now()
    db.execute(delete(LoginDevice).where(
        LoginDevice.restaurant_id == restaurant_id,
        LoginDevice.last_seen_at < now - timedelta(days=settings.device_retention_days), ~_live_token()))
    old = now - timedelta(days=settings.pin_session_retention_days)
    db.execute(delete(StaffPinSession).where(
        StaffPinSession.restaurant_id == restaurant_id,
        or_(StaffPinSession.ended_at < old, and_(StaffPinSession.ended_at.is_(None), StaffPinSession.expires_at < old))))
    db.execute(delete(PinLockout).where(
        PinLockout.restaurant_id == restaurant_id, PinLockout.last_failure_at < now - timedelta(days=2),
        or_(PinLockout.locked_until.is_(None), PinLockout.locked_until < now)))


# ------------------------------------------------------------------------------------------------ counter devices
def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def register_counter(db: Session, p, name: str, outlet_id: uuid.UUID | None) -> tuple[CounterDevice, str]:
    oid = outlet_id or p.outlet_id or outlets.outlet_of(db, p)
    o = db.get(Outlet, oid)
    if o is None or o.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Outlet not found")
    if p.outlet_ids is not None and oid not in p.outlet_ids:
        raise HTTPException(403, "No access to this outlet")
    if not o.is_active:
        raise HTTPException(409, "Outlet is inactive")
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    d = CounterDevice(restaurant_id=p.restaurant_id, outlet_id=oid, name=name.strip()[:100], token_hash=hash_token(token),
                      created_by=p.user_id)
    db.add(d)
    db.flush()
    audit.record(db, p, "device.counter.register", "counter_device", d.id, {"name": d.name, "outlet_id": str(oid)})
    db.commit()
    return d, token


def list_counters(db: Session, p) -> list[dict]:
    now = _now()
    idle = timedelta(minutes=settings.pin_idle_minutes)
    active = (select(func.count()).where(StaffPinSession.counter_device_id == CounterDevice.id, StaffPinSession.ended_at.is_(None),
                                         StaffPinSession.expires_at > now, StaffPinSession.last_activity_at > now - idle)
              .correlate(CounterDevice).scalar_subquery())
    q = (select(CounterDevice, Outlet.name, active.label("active_sessions"))
         .join(Outlet, Outlet.id == CounterDevice.outlet_id).where(CounterDevice.restaurant_id == p.restaurant_id))
    if p.outlet_ids is not None:
        q = q.where(CounterDevice.outlet_id.in_(p.outlet_ids))
    return [{"id": d.id, "name": d.name, "outlet_id": d.outlet_id, "outlet_name": oname, "created_at": d.created_at,
             "created_by": d.created_by, "last_seen_at": d.last_seen_at, "last_ip": d.last_ip, "revoked_at": d.revoked_at,
             "active_sessions": n}
            for d, oname, n in db.execute(q.order_by(CounterDevice.revoked_at.is_not(None), CounterDevice.created_at.desc()))]


def revoke_counter(db: Session, p, device_id: uuid.UUID) -> None:
    d = db.scalar(select(CounterDevice).where(CounterDevice.id == device_id, CounterDevice.restaurant_id == p.restaurant_id)
                  .with_for_update())
    if d is None or (p.outlet_ids is not None and d.outlet_id not in p.outlet_ids):
        raise HTTPException(404, "Device not found")
    now = _now()
    if d.revoked_at is None:
        d.revoked_at, d.revoked_by = now, p.user_id
    n = db.execute(update(StaffPinSession).where(StaffPinSession.counter_device_id == d.id, StaffPinSession.ended_at.is_(None))
                   .values(ended_at=now, end_reason="device_revoked")).rowcount
    audit.record(db, p, "device.counter.revoke", "counter_device", d.id, {"name": d.name, "pin_sessions_ended": n})
    db.commit()


def authenticate_counter(db: Session, token: str | None, ip: str | None = None) -> CounterDevice:
    """The counter device behind a credential, with the session bound to its tenant; 401 for anything else (unknown,
    revoked, malformed). The lookup before the tenant is known goes through a SECURITY DEFINER function (ids only)."""
    if not token or not token.startswith(TOKEN_PREFIX) or len(token) > 200:
        raise HTTPException(401, "Invalid device credential")
    h = hash_token(token)
    with SessionLocal() as s:
        found = s.execute(text("SELECT device_id, tenant_id FROM counter_device_by_token(:h)"), {"h": h}).first()
    if found is None:
        raise HTTPException(401, "Invalid device credential")
    bind_tenant(db, found.tenant_id)
    d = db.get(CounterDevice, found.device_id)
    if d is None or not hmac.compare_digest(d.token_hash, h) or d.revoked_at is not None:
        raise HTTPException(401, "Invalid device credential")
    now = _now()
    if d.last_seen_at is None or now - d.last_seen_at > timedelta(seconds=30) or (ip and d.last_ip != ip[:64]):
        d.last_seen_at, d.last_ip = now, (ip or d.last_ip or "")[:64] or None
        db.commit()
    return d


def device_principal(d: CounterDevice) -> SimpleNamespace:
    """What the counter read routes see: the device's tenant and outlet, NO permissions. Never a user."""
    return SimpleNamespace(user_id=None, restaurant_id=d.restaurant_id, outlet_id=d.outlet_id, outlet_ids=(d.outlet_id,),
                           permissions=frozenset(), support=None, can=lambda *perms: False)


def initials(name: str) -> str:
    parts = [w for w in name.replace(".", " ").split() if w]
    if not parts:
        return "?"
    return (parts[0][0] + (parts[-1][0] if len(parts) > 1 else "")).upper()


def allowed_at(db: Session, user: User, outlet_id: uuid.UUID) -> bool:
    perms = permissions.resolve(db, user)
    _, allowed = outlets.resolve_access(db, user, None, "GET", all_outlets=P.OUTLETS_ACCESS_ALL in perms)
    return allowed is not None and outlet_id in allowed


def roster(db: Session, d: CounterDevice) -> dict:
    """Active staff who have a PIN and may work at the device's outlet: id, name, role, initials only."""
    from app.models.devices import StaffPin
    users = db.scalars(select(User).join(StaffPin, StaffPin.user_id == User.id)
                       .where(User.restaurant_id == d.restaurant_id, User.is_active).order_by(User.full_name)).all()
    o = db.get(Outlet, d.outlet_id)
    r = db.get(Restaurant, d.restaurant_id)
    staff = [{"id": u.id, "name": u.full_name, "role": u.role.value, "initials": initials(u.full_name)}
             for u in users if allowed_at(db, u, d.outlet_id)]
    return {"device": {"id": d.id, "name": d.name, "outlet_id": d.outlet_id, "outlet_name": o.name if o else None,
                       "restaurant_name": r.name if r else None},
            "staff": staff}
