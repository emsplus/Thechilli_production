"""Staff accounts and the restaurant-code sign-in (docs/STAFF_WIRING_CHECK.md).

Who may add / change whom (every rule here, routes only check the permission):
* a caller can only create, or turn a user into, a role whose permissions it holds itself; only a full owner (a caller
  holding every permission) creates owners;
* a caller can only change (rename, re-role, reset the password of, deactivate, re-grant outlets to) a user whose
  permissions it holds itself, so a custom role holding staff.reset_password cannot take over an owner's account;
* every lookup is inside the caller's tenant (another tenant's user id is a plain 404).

Sign-in identifiers: email (optional), phone, username, each unique inside one restaurant only. The restaurant's login code
picks the tenant, so the same phone or username can exist in two restaurants without ambiguity.
"""
from __future__ import annotations

import functools
import re
import secrets
import uuid
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import permissions
from app.core.config import settings
from app.core.security import hash_password, verify_password
from app.core.tenancy import bind_tenant
from app.models.core import LoginAttempt, Outlet, Restaurant, Role, User, UserOutletAccess
from app.services import audit, tokens

_BY_CODE = text("SELECT auth_restaurant_by_code(:c)")
_DUMMY_HASH = hash_password("dummy-password-for-timing-staff")
_USERNAME = re.compile(r"[a-z][a-z0-9._-]{2,39}")
_TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # lower-case + digits without look-alikes: easy to type on a phone


# ------------------------------------------------------------------------------------------------ identifiers
def normalise_phone(v: str) -> str:
    """'+91 98765-43210', '098765 43210', '9876543210' -> '+919876543210'. A 10-digit number is Indian (+91). ValueError if
    it is not a plausible phone number."""
    raw = v.strip()
    if not re.fullmatch(r"\+?[0-9 ()\-.]{6,25}", raw):
        raise ValueError("Enter a valid phone number")
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+"):
        out = digits
    elif len(digits) == 10:
        out = "91" + digits
    elif len(digits) == 11 and digits.startswith("0"):
        out = "91" + digits[1:]
    elif len(digits) == 12 and digits.startswith("91"):
        out = digits
    else:
        out = digits
    if not 8 <= len(out) <= 15:
        raise ValueError("Enter a valid phone number")
    return "+" + out


def normalise_username(v: str) -> str:
    u = v.strip().lower()
    if not _USERNAME.fullmatch(u):
        raise ValueError("A username is 3 to 40 characters: letters, digits, '.', '_' or '-', starting with a letter")
    return u


def classify(identifier: str) -> tuple[str, str] | None:
    """('email' | 'phone' | 'username', normalised value) of what a person typed at sign-in, or None."""
    v = identifier.strip()
    if "@" in v:
        return "email", v.lower()
    if re.fullmatch(r"\+?[0-9 ()\-.]+", v):
        try:
            return "phone", normalise_phone(v)
        except ValueError:
            return None
    try:
        return "username", normalise_username(v)
    except ValueError:
        return None


def login_identifier(u: User) -> str:
    """What the user types next to the restaurant code: phone, else username, else email."""
    return u.phone or u.username or u.email or ""


def throttle_key_of(u: User) -> str:
    """The failed-login budget of a user: its email (shared with the email sign-in), else the code sign-in key."""
    return u.email.strip().lower() if u.email else f"code:{u.restaurant_id}:{u.phone or u.username}"


def new_temporary_password() -> str:
    """12 random characters (~59 bits) shown as xxxx-xxxx-xxxx; always has a digit and a letter."""
    while True:
        s = "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(12))
        if any(c.isdigit() for c in s) and any(c.isalpha() for c in s):
            return f"{s[:4]}-{s[4:8]}-{s[8:]}"


# ------------------------------------------------------------------------------------------------ sign-in with a code
def restaurant_by_code(db: Session, code: str | None) -> uuid.UUID | None:
    if not code or not re.fullmatch(r"[A-Z0-9]{4,8}", code):
        return None
    return db.scalar(_BY_CODE, {"c": code})


def authenticate_with_code(db: Session, code: str, identifier: str, password: str, ip: str = "unknown") -> User:
    """The active user of restaurant `code` whose phone / username / email is `identifier` and whose password is `password`,
    with the tenant bound; else 401 'Invalid credentials' (the same answer for an unknown code, an unknown identifier, an
    inactive user and a wrong password; a hash is always verified so the timing is alike). Throttled like email sign-in,
    per (code, identifier)."""
    from app.services import accounts  # local: accounts imports this module
    kind = classify(identifier)
    key = f"code:{code}:{kind[1] if kind else identifier.strip().lower()}"[:255]
    wait = accounts.retry_after(db, key, ip)  # the same (key, IP) / IP / key budgets as email sign-in (security finding 4)
    if wait:
        raise HTTPException(429, "Too many failed login attempts. Try again later.", headers={"Retry-After": str(wait)})
    rid = restaurant_by_code(db, code)
    u = None
    if rid is not None and kind is not None:
        bind_tenant(db, rid)
        col = {"email": func.lower(User.email), "phone": User.phone, "username": User.username}[kind[0]]
        u = db.scalars(select(User).where(User.restaurant_id == rid, col == kind[1]).order_by(User.created_at)).first()
    ok = verify_password(password, u.password_hash if u else _DUMMY_HASH)
    if not u or not u.is_active or not ok:
        db.rollback()
        accounts.record_failure(db, key, ip)
        raise HTTPException(401, "Invalid credentials")
    accounts.clear_failures(db, key)
    return u


# ------------------------------------------------------------------------------------------------ escalation guards
def _full_owner(p) -> bool:
    return permissions.ALL_PERMISSIONS <= p.permissions


def require_can_grant(p, role: Role, what: str = "create") -> None:
    """403 unless the caller holds every permission of `role` (and only full owners hand out the owner role)."""
    if role == Role.owner and not _full_owner(p):
        raise HTTPException(403, "Only an owner can create owners" if what == "create" else "Only an owner can make owners")
    missing = sorted(permissions.system_role_permissions(role) - p.permissions)
    if missing:
        raise HTTPException(403, f"You cannot {what} a {role.value}: that role holds permissions you do not have ({', '.join(missing[:5])})")


def require_can_manage(db: Session, p, target: User, action: str) -> None:
    """403 unless the caller holds every permission the target holds (owners always may; nobody else may touch an owner)."""
    if _full_owner(p):
        return
    if target.role == Role.owner and target.custom_role_id is None:
        raise HTTPException(403, f"Only an owner can {action} an owner")
    if not permissions.resolve(db, target) <= p.permissions:
        raise HTTPException(403, f"You cannot {action} a user who holds permissions you do not have")


def require_can_scope(p, target: User) -> None:
    """Outlet grants: narrowing or widening WHERE someone works gives the caller nothing it lacks (and outlets.set_access
    keeps an outlet-bound delegate inside its own outlets), so only owners are protected: nobody but an owner changes an
    owner's outlets."""
    if not _full_owner(p) and target.role == Role.owner and target.custom_role_id is None:
        raise HTTPException(403, "Only an owner can change the outlets of an owner")


def get_user(db: Session, p, user_id: uuid.UUID, lock: bool = False) -> User:
    q = select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id)
    u = db.scalar(q.with_for_update() if lock else q)
    if u is None:
        raise HTTPException(404, "User not found")
    return u


# ------------------------------------------------------------------------------------------------ create
def _taken(db: Session, rid: uuid.UUID, *, email=None, phone=None, username=None, exclude: uuid.UUID | None = None) -> str | None:
    for field, col, val in (("email", func.lower(User.email), email), ("phone", User.phone, phone),
                            ("username", User.username, username)):
        if val is None:
            continue
        q = select(User.id).where(User.restaurant_id == rid, col == val)
        if exclude is not None:
            q = q.where(User.id != exclude)
        if db.scalar(q.limit(1)):
            return field
    return None


_TAKEN_MSG = {"email": "Email already in use", "phone": "This phone number is already used by someone in this restaurant",
              "username": "This username is already used in this restaurant"}


def _check_outlets(db: Session, p, outlet_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    wanted = list(dict.fromkeys(outlet_ids))
    if not wanted:
        return []
    found = set(db.scalars(select(Outlet.id).where(Outlet.restaurant_id == p.restaurant_id, Outlet.id.in_(wanted))))
    if found != set(wanted):
        raise HTTPException(404, "Outlet not found")
    if getattr(p, "outlet_ids", None) is not None and not set(wanted) <= set(p.outlet_ids):
        raise HTTPException(403, "Cannot grant outlets you cannot access yourself")
    return wanted


def invite_link(token: str) -> str:
    base = (settings.app_base_url or settings.public_base_url or (settings.cors_origins[0] if settings.cors_origins else "")).rstrip("/")
    return f"{base}/accept-invite#token={quote(token, safe='')}"


def _send_invite(db: Session, u: User, restaurant: Restaurant, locale: str) -> dict:
    from app.services import account_mail, mail, provisioning  # local: heavy imports, and provisioning imports models
    token, inv = provisioning.issue_invite(db, u)
    url = invite_link(token)
    sent = bool(u.email) and mail.get_provider() is not None
    if sent:
        # mail.submit takes positional arguments only: the template values go in through a partial
        mail.submit(functools.partial(account_mail._deliver, name=u.full_name, code=restaurant.login_code,
                                      hours=settings.provision_invite_hours), "staff_invite", u.email, locale, restaurant.name, url)
    return {"sent": sent, "url": url, "expires_at": inv.expires_at}


def create_staff(db: Session, p, data, locale: str = "en") -> dict:
    require_can_grant(p, data.role)
    field = _taken(db, p.restaurant_id, email=data.email, phone=data.phone, username=data.username)
    if field:
        raise HTTPException(409, _TAKEN_MSG[field])
    outlet_ids = _check_outlets(db, p, data.outlet_ids or [])
    temp = None
    if data.password:
        pw, must_change = data.password, False
    elif data.send_invite:
        pw, must_change = secrets.token_urlsafe(48), False  # nobody knows it: the invite sets the real one
    else:
        temp = new_temporary_password()
        pw, must_change = temp, True
    u = User(restaurant_id=p.restaurant_id, email=data.email, phone=data.phone, username=data.username,
             full_name=data.full_name, password_hash=hash_password(pw), role=data.role, must_change_password=must_change)
    db.add(u)
    try:
        db.flush()
    except IntegrityError:  # a concurrent create took the identifier
        db.rollback()
        raise HTTPException(409, "Email, phone or username already in use in this restaurant")
    for oid in outlet_ids:
        db.add(UserOutletAccess(user_id=u.id, outlet_id=oid, restaurant_id=p.restaurant_id))
    rest = db.get(Restaurant, p.restaurant_id)
    invite = _send_invite(db, u, rest, locale) if data.send_invite else None
    audit.record(db, p, "user.create", "user", u.id, {
        "role": data.role.value, "identifiers": [k for k in ("email", "phone", "username") if getattr(u, k)],
        "outlet_ids": [str(o) for o in outlet_ids], "credentials": "password" if data.password else
        ("invite" if data.send_invite else "temporary_password")})
    db.commit()
    return _created(u, rest, outlet_ids, temp, invite)


def _created(u: User, rest: Restaurant, outlet_ids, temp, invite) -> dict:
    return dict(id=u.id, email=u.email, phone=u.phone, username=u.username, full_name=u.full_name, role=u.role,
                is_active=u.is_active, custom_role_id=u.custom_role_id, must_change_password=u.must_change_password,
                restaurant_code=rest.login_code, login_identifier=login_identifier(u), temporary_password=temp,
                invite=invite, outlet_ids=list(outlet_ids))


# ------------------------------------------------------------------------------------------------ owner actions
def temporary_password(db: Session, p, user_id: uuid.UUID) -> dict:
    """Owner action: a new one-time password for a staff member (shown once), every session of that user ends."""
    if user_id == p.user_id:
        raise HTTPException(409, "Use change password for your own account")
    u = get_user(db, p, user_id, lock=True)
    require_can_manage(db, p, u, "reset the password of")
    temp = new_temporary_password()
    u.password_hash = hash_password(temp)
    u.must_change_password = True
    db.execute(delete(LoginAttempt).where(LoginAttempt.email == throttle_key_of(u)))
    tokens.revoke_user(db, u.id, "password_reset")
    audit.record(db, p, "user.temporary_password", "user", u.id)
    rest = db.get(Restaurant, p.restaurant_id)
    db.commit()
    return {"temporary_password": temp, "restaurant_code": rest.login_code, "login_identifier": login_identifier(u)}


def resend_invite(db: Session, p, user_id: uuid.UUID, locale: str = "en") -> dict:
    u = get_user(db, p, user_id, lock=True)
    require_can_manage(db, p, u, "invite")
    if not u.email:
        raise HTTPException(422, "This staff member has no email address")
    if not u.is_active:
        raise HTTPException(409, "Reactivate the staff member first")
    out = _send_invite(db, u, db.get(Restaurant, p.restaurant_id), locale)
    audit.record(db, p, "user.invite", "user", u.id)
    db.commit()
    return out


def apply_identifier_changes(db: Session, p, target: User, sent: dict) -> dict:
    """Validates and applies email / phone / username edits from a PATCH; returns {field: new value} that changed."""
    new = {}
    for k in ("email", "phone", "username"):
        if k not in sent:
            continue
        v = sent[k]
        if isinstance(v, str) and not v.strip():
            v = None
        if v is not None:
            try:
                v = v.strip().lower() if k == "email" else normalise_phone(v) if k == "phone" else normalise_username(v)
            except ValueError as e:
                raise HTTPException(422, str(e))
        new[k] = v
    if not new:
        return {}
    after = {k: new.get(k, getattr(target, k)) for k in ("email", "phone", "username")}
    if not any(after.values()):
        raise HTTPException(422, "A user keeps at least one of email, phone or username")
    field = _taken(db, p.restaurant_id, exclude=target.id, **{k: v for k, v in new.items() if v is not None})
    if field:
        raise HTTPException(409, _TAKEN_MSG[field])
    return new
