"""Custom roles management (docs/ROLES_API.md). Rules, all enforced here (routes only check roles.manage / users.manage):

* system roles are read-only (listed, cloneable, never edited or deleted);
* no privilege escalation: a caller can only put permissions into a role, or assign a role, whose permissions it holds itself,
  and cannot change a user who holds permissions it lacks;
* a role in use (any user, active or not) cannot be deleted or deactivated (409);
* only an owner (a caller holding every permission) assigns the owner role; the last active owner cannot be demoted;
* a caller cannot take roles.manage / users.manage away from itself."""
from __future__ import annotations

import re
import uuid

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import permission_catalogue as cat, permissions
from app.core.permissions import ALL_PERMISSIONS, P, SYSTEM_ROLE_NAMES, SYSTEM_ROLE_PERMISSIONS
from app.models.core import Outlet, Role, RoleDef, RolePermission, User
from app.schemas.roles import OutletEffect, PermissionSnapshot, RoleOut, UserRoleOut
from app.services import audit, outlets

_LOCKOUT = (P.ROLES_MANAGE, P.USERS_MANAGE)
ACCESS_ALL_EFFECT = ("Reaches every outlet of the restaurant (including outlets created later); per-user outlet grants are ignored.")
NO_ACCESS_ALL_EFFECT = ("Does NOT reach every outlet: users with this role only see data of the outlets granted to them "
                        "(PUT /users/{id}/outlets), or the default outlet when none are granted. Reports, bills and orders of "
                        "other outlets stay invisible.")


# ---------------------------------------------------------------------------------------------------------------- helpers
def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50]
    return s or f"role-{uuid.uuid4().hex[:8]}"


def _validate(perms) -> frozenset[str]:
    try:
        return permissions.validate(perms)
    except ValueError:
        unknown = sorted(set(perms) - ALL_PERMISSIONS)
        raise HTTPException(422, f"Unknown permissions: {unknown}")


def _need_held(p, perms: frozenset[str], what: str = "grant") -> None:
    missing = sorted(perms - p.permissions)
    if missing:
        raise HTTPException(403, f"Cannot {what} permissions you do not hold yourself: {missing}")


def _perms_of(db: Session, role: RoleDef) -> frozenset[str]:
    if role.is_system:
        return SYSTEM_ROLE_PERMISSIONS.get(role.key, frozenset())
    return frozenset(db.scalars(select(RolePermission.permission).where(RolePermission.role_id == role.id))) & ALL_PERMISSIONS


def _snapshot(perms: frozenset[str]) -> PermissionSnapshot:
    allp = P.OUTLETS_ACCESS_ALL in perms
    return PermissionSnapshot(count=len(perms), by_area=cat.by_area(perms),
                              outlets=OutletEffect(access_all=allp, effect=ACCESS_ALL_EFFECT if allp else NO_ACCESS_ALL_EFFECT))


def _user_count(db: Session, role: RoleDef, rid: uuid.UUID) -> int:
    n = db.scalar(select(func.count()).select_from(User).where(User.restaurant_id == rid, User.custom_role_id == role.id))
    if role.is_system and role.key in Role.__members__:
        n += db.scalar(select(func.count()).select_from(User).where(
            User.restaurant_id == rid, User.custom_role_id.is_(None), User.role == Role[role.key]))
    return n


def to_out(db: Session, rid: uuid.UUID, role: RoleDef, perms: frozenset[str] | None = None) -> RoleOut:
    perms = _perms_of(db, role) if perms is None else perms
    return RoleOut(id=role.id, key=role.key, name=role.name, is_system=role.is_system, is_active=role.is_active,
                   editable=not role.is_system, permissions=sorted(perms), permission_snapshot=_snapshot(perms),
                   user_count=_user_count(db, role, rid), created_at=role.created_at)


def _visible(db: Session, p, role_id: uuid.UUID, lock: bool = False) -> RoleDef:
    q = select(RoleDef).where(RoleDef.id == role_id, (RoleDef.restaurant_id == p.restaurant_id) | RoleDef.restaurant_id.is_(None))
    role = db.scalar(q)
    if role is None:
        raise HTTPException(404, "Role not found")
    if lock and not role.is_system:  # FOR UPDATE on a system row is invisible under RLS (read-only policy): lock custom roles only
        role = db.scalar(q.where(RoleDef.restaurant_id == p.restaurant_id).with_for_update().execution_options(populate_existing=True))
        if role is None:
            raise HTTPException(404, "Role not found")
    return role


def _taken(db: Session, p, name: str, exclude: uuid.UUID | None = None) -> str:
    """409 when the name (case-insensitive) is used by a system role or another role of the tenant; returns a free key."""
    low = name.lower()
    if low in {v.lower() for v in SYSTEM_ROLE_NAMES.values()} | set(SYSTEM_ROLE_NAMES):
        raise HTTPException(409, "That name is reserved for a built-in role")
    rows = db.execute(select(RoleDef.id, RoleDef.name, RoleDef.key).where(RoleDef.restaurant_id == p.restaurant_id)).all()
    if any(r.name.lower() == low and r.id != exclude for r in rows):
        raise HTTPException(409, "A role with this name already exists")
    keys = {r.key for r in rows if r.id != exclude}
    key, n = _slug(name), 2
    while key in keys:
        key, n = f"{_slug(name)[:45]}-{n}", n + 1
    return key


# ---------------------------------------------------------------------------------------------------------------- reads
def list_roles(db: Session, p) -> list[RoleOut]:
    roles = list(db.scalars(select(RoleDef).where((RoleDef.restaurant_id == p.restaurant_id) | RoleDef.restaurant_id.is_(None))))
    order = list(SYSTEM_ROLE_NAMES)
    roles.sort(key=lambda r: (not r.is_system, order.index(r.key) if r.is_system and r.key in order else 0, r.name.lower()))
    custom_ids = [r.id for r in roles if not r.is_system]
    rows = db.execute(select(RolePermission.role_id, RolePermission.permission).where(RolePermission.role_id.in_(custom_ids))).all() if custom_ids else []
    per: dict[uuid.UUID, set[str]] = {}
    for rid, perm in rows:
        per.setdefault(rid, set()).add(perm)
    return [to_out(db, p.restaurant_id, r, SYSTEM_ROLE_PERMISSIONS.get(r.key, frozenset()) if r.is_system else frozenset(per.get(r.id, ())) & ALL_PERMISSIONS)
            for r in roles]


def get_role(db: Session, p, role_id: uuid.UUID) -> RoleOut:
    return to_out(db, p.restaurant_id, _visible(db, p, role_id))


# ---------------------------------------------------------------------------------------------------------------- writes
def _set_perms(db: Session, role: RoleDef, perms: frozenset[str]) -> None:
    db.execute(delete(RolePermission).where(RolePermission.role_id == role.id))
    for x in sorted(perms):
        db.add(RolePermission(role_id=role.id, permission=x))


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError:  # concurrent create with the same name / key
        db.rollback()
        raise HTTPException(409, "A role with this name already exists")


def create_role(db: Session, p, name: str, perms) -> RoleOut:
    perms = _validate(perms)
    _need_held(p, perms)
    key = _taken(db, p, name)
    role = RoleDef(restaurant_id=p.restaurant_id, key=key, name=name, is_system=False, is_active=True)
    db.add(role)
    db.flush()
    _set_perms(db, role, perms)
    audit.record(db, p, "role.create", "role", role.id, {"name": name, "permissions": sorted(perms)})
    _commit(db)
    return to_out(db, p.restaurant_id, role, perms)


def clone_roles(db: Session, p, source_id: uuid.UUID, names: list[str]) -> list[RoleOut]:
    src = _visible(db, p, source_id)
    perms = _perms_of(db, src)
    _need_held(p, perms, "copy a role with")
    if len({n.lower() for n in names}) != len(names):
        raise HTTPException(409, "Duplicate names in the request")
    out = []
    for name in names:
        key = _taken(db, p, name)
        role = RoleDef(restaurant_id=p.restaurant_id, key=key, name=name, is_system=False, is_active=True)
        db.add(role)
        db.flush()
        _set_perms(db, role, perms)
        audit.record(db, p, "role.clone", "role", role.id, {"name": name, "source_role_id": str(src.id), "source": src.key,
                                                             "permissions": sorted(perms)})
        out.append((role, perms))
    _commit(db)
    return [to_out(db, p.restaurant_id, r, x) for r, x in out]


def _caller_role_id(db: Session, p) -> uuid.UUID | None:
    return db.scalar(select(User.custom_role_id).where(User.id == p.user_id))


def update_role(db: Session, p, role_id: uuid.UUID, data) -> RoleOut:
    role = _visible(db, p, role_id, lock=True)
    if role.is_system:
        raise HTTPException(403, "Built-in roles cannot be edited")
    old = _perms_of(db, role)
    new = _validate(data.permissions) if data.permissions is not None else old
    _need_held(p, old, "edit a role that carries")
    _need_held(p, new)
    in_use = db.scalar(select(func.count()).select_from(User).where(User.custom_role_id == role.id)) or 0
    mine = _caller_role_id(db, p) == role.id
    active = role.is_active if data.is_active is None else data.is_active
    if mine and ((P.ROLES_MANAGE in p.permissions and P.ROLES_MANAGE not in new) or
                 (P.USERS_MANAGE in p.permissions and P.USERS_MANAGE not in new) or not active):
        raise HTTPException(409, "This would remove your own role management access")
    if not active and role.is_active and in_use:
        raise HTTPException(409, f"Role is assigned to {in_use} user(s); reassign them before deactivating it")
    changes: dict = {}
    if data.name is not None and data.name != role.name:
        role.key = _taken(db, p, data.name, exclude=role.id) if _slug(data.name) != role.key else role.key
        changes["name"] = {"old": role.name, "new": data.name}
        role.name = data.name
    if data.permissions is not None and new != old:
        changes["permissions"] = {"added": sorted(new - old), "removed": sorted(old - new)}
        _set_perms(db, role, new)
    if active != role.is_active:
        changes["is_active"] = {"old": role.is_active, "new": active}
        role.is_active = active
    if changes:
        audit.record(db, p, "role.update", "role", role.id, {**changes, "users_affected": in_use})
        _commit(db)
    return to_out(db, p.restaurant_id, role, new)


def delete_role(db: Session, p, role_id: uuid.UUID) -> None:
    role = _visible(db, p, role_id, lock=True)
    if role.is_system:
        raise HTTPException(403, "Built-in roles cannot be deleted")
    old = _perms_of(db, role)
    _need_held(p, old, "delete a role that carries")
    if _caller_role_id(db, p) == role.id:
        raise HTTPException(409, "You cannot delete the role you hold")
    users = db.scalar(select(func.count()).select_from(User).where(User.custom_role_id == role.id)) or 0
    if users:
        raise HTTPException(409, f"Role is assigned to {users} user(s); reassign them first")
    audit.record(db, p, "role.delete", "role", role.id, {"name": role.name, "permissions": sorted(old)})
    db.execute(delete(RolePermission).where(RolePermission.role_id == role.id))
    db.delete(role)
    _commit(db)


# ---------------------------------------------------------------------------------------------------------------- users
def _user_role_out(db: Session, u: User) -> UserRoleOut:
    if u.custom_role_id is not None:
        role = db.get(RoleDef, u.custom_role_id)
    else:
        role = db.scalar(select(RoleDef).where(RoleDef.restaurant_id.is_(None), RoleDef.key == u.role.value))
    perms = permissions.resolve(db, u)
    if role is None:  # system row missing (not seeded): describe it from the code
        role = RoleDef(id=uuid.uuid4(), key=u.role.value, name=SYSTEM_ROLE_NAMES[u.role.value], is_system=True, is_active=True)
    return UserRoleOut(user_id=u.id, email=u.email, full_name=u.full_name, is_active=u.is_active, role=u.role,
                       custom_role_id=u.custom_role_id, effective_role=to_out(db, u.restaurant_id, role, perms))


def get_user_role(db: Session, p, user_id: uuid.UUID) -> UserRoleOut:
    u = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id))
    if not u:
        raise HTTPException(404, "User not found")
    return _user_role_out(db, u)


def assign_role(db: Session, p, user_id: uuid.UUID, data) -> UserRoleOut:
    # lock the tenant's owners first (same order as manage.patch_user / accounts.set_active) so two callers cannot demote
    # each other's last-owner guard concurrently
    owners = db.scalars(select(User).where(User.restaurant_id == p.restaurant_id, User.role == Role.owner)
                        .order_by(User.id).with_for_update()).all()
    target = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id).with_for_update())
    if not target:
        raise HTTPException(404, "User not found")
    system_role: Role | None = data.role
    custom: RoleDef | None = None
    if data.role_id is not None:
        r = _visible(db, p, data.role_id)
        if r.is_system:
            if r.key not in Role.__members__:
                raise HTTPException(404, "Role not found")
            system_role = Role[r.key]
        else:
            custom = r
            if not r.is_active:
                raise HTTPException(409, "Role is inactive")
    new_perms = system_role_perms(system_role) if custom is None else _perms_of(db, custom)
    # owner-only rule: only a full owner hands out the owner role
    if system_role == Role.owner and not ALL_PERMISSIONS <= p.permissions:
        raise HTTPException(403, "Only an owner can assign the owner role")
    _need_held(p, new_perms, "assign a role with")
    current = permissions.resolve(db, target)
    _need_held(p, current, "change a user who holds")
    if target.id == p.user_id:
        lost = [x for x in _LOCKOUT if x in p.permissions and x not in new_perms]
        if lost:
            raise HTTPException(409, f"You cannot remove your own {lost[0]} permission")
    was_owner = target.role == Role.owner and target.custom_role_id is None
    if was_owner and system_role != Role.owner:
        if not any(o.is_active and o.id != target.id and o.custom_role_id is None for o in owners):
            raise HTTPException(409, "Cannot demote the last active owner")
    old = {"role": target.role.value, "custom_role_id": str(target.custom_role_id) if target.custom_role_id else None}
    if custom is None:
        target.role, target.custom_role_id = system_role, None
    else:
        target.custom_role_id = custom.id
        if target.role == Role.owner:  # a custom role is a demotion: the legacy enum must never leave a non-owner as 'owner'
            target.role = Role.manager
    new = {"role": target.role.value, "custom_role_id": str(target.custom_role_id) if target.custom_role_id else None}
    if old != new:
        audit.record(db, p, "user.role_assign", "user", target.id,
                     {"old": old, "new": new, "permissions_added": sorted(new_perms - current), "permissions_removed": sorted(current - new_perms)})
    db.commit()
    return _user_role_out(db, target)


def system_role_perms(role: Role) -> frozenset[str]:
    return SYSTEM_ROLE_PERMISSIONS[role.value]


# ---------------------------------------------------------------------------------------------------------------- outlet access
def user_outlet_access(db: Session, p, user_id: uuid.UUID) -> dict:
    u = db.scalar(select(User).where(User.id == user_id, User.restaurant_id == p.restaurant_id))
    if not u:
        raise HTTPException(404, "User not found")
    grants = outlets.get_access(db, p.restaurant_id, user_id)
    all_ = P.OUTLETS_ACCESS_ALL in permissions.resolve(db, u)
    rows = db.execute(select(Outlet.id, Outlet.is_default).where(Outlet.restaurant_id == p.restaurant_id)
                      .order_by(Outlet.is_default.desc(), Outlet.created_at, Outlet.code)).all()
    if all_:
        eff, note = [r.id for r in rows], "The user's role holds outlets.access_all: every outlet is reachable and grants are ignored."
    else:
        gs = set(grants)
        eff = [r.id for r in rows if r.id in gs] or [r.id for r in rows[:1]]
        note = ("Without outlets.access_all the user reaches only the granted outlets" +
                (" (none granted: the default outlet)." if not gs else "."))
    return {"outlet_ids": sorted(grants, key=str), "access_all": all_, "effective_outlet_ids": eff, "note": note}


def set_user_outlet_access(db: Session, p, user_id: uuid.UUID, outlet_ids: list[uuid.UUID]) -> dict:
    from app.services import staff_accounts  # local: staff_accounts -> accounts -> ... keeps import order simple
    staff_accounts.require_can_scope(p, staff_accounts.get_user(db, p, user_id))
    wanted = set(outlet_ids)
    if wanted and set(db.scalars(select(Outlet.id).where(Outlet.restaurant_id == p.restaurant_id, Outlet.id.in_(wanted)))) != wanted:
        raise HTTPException(404, "Outlet not found")
    if p.outlet_ids is not None and not wanted <= set(p.outlet_ids):
        raise HTTPException(403, "Cannot grant outlets you cannot access yourself")
    outlets.set_access(db, p, user_id, outlet_ids)
    return user_outlet_access(db, p, user_id)
