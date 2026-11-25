"""Custom roles, role assignment, permission catalogue, per-user outlet access (docs/ROLES_API.md)."""
import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core import permission_catalogue
from app.core.db import get_db
from app.schemas.common import OutletAccessIn
from app.schemas.roles import RoleAssign, RoleClone, RoleCreate, RoleOut, RolePatch, UserOutletAccessOut, UserRoleOut
from app.services import roles as svc

router = APIRouter(tags=["roles"])
READ = (P.ROLES_MANAGE, P.USERS_MANAGE)


@router.get("/permissions")
def permission_catalogue_(lang: str = Query(default="en", pattern="^(en|hi|all)$"),
                          p: Principal = Depends(require_perm(*READ))):
    """Every known permission grouped by area. English only by default (`label` / `note` = {"en": ...}); `?lang=all` also returns
    the Hindi strings ({"en", "hi"}). `grantable` = the caller holds it (only those can be put in a role)."""
    return {"areas": permission_catalogue.catalogue(p.permissions, lang)}


@router.get("/roles", response_model=list[RoleOut])
def list_roles(p: Principal = Depends(require_perm(*READ)), db: Session = Depends(get_db)):
    """The five built-in roles (read-only) followed by the restaurant's custom roles."""
    return svc.list_roles(db, p)


@router.post("/roles", response_model=RoleOut, status_code=201)
def create_role(data: RoleCreate, p: Principal = Depends(require_perm(P.ROLES_MANAGE)), db: Session = Depends(get_db)):
    return svc.create_role(db, p, data.name, data.permissions)


@router.get("/roles/{role_id}", response_model=RoleOut)
def get_role(role_id: uuid.UUID, p: Principal = Depends(require_perm(*READ)), db: Session = Depends(get_db)):
    return svc.get_role(db, p, role_id)


@router.patch("/roles/{role_id}", response_model=RoleOut)
def patch_role(role_id: uuid.UUID, data: RolePatch, p: Principal = Depends(require_perm(P.ROLES_MANAGE)), db: Session = Depends(get_db)):
    return svc.update_role(db, p, role_id, data)


@router.delete("/roles/{role_id}", status_code=204)
def delete_role(role_id: uuid.UUID, p: Principal = Depends(require_perm(P.ROLES_MANAGE)), db: Session = Depends(get_db)):
    svc.delete_role(db, p, role_id)
    return Response(status_code=204)


@router.post("/roles/{role_id}/clone", response_model=list[RoleOut], status_code=201)
def clone_role(role_id: uuid.UUID, data: RoleClone, p: Principal = Depends(require_perm(P.ROLES_MANAGE)), db: Session = Depends(get_db)):
    """Copies a built-in or custom role into one new custom role per name (all or nothing)."""
    return svc.clone_roles(db, p, role_id, data.names)


@router.get("/users/{user_id}/role", response_model=UserRoleOut)
def get_user_role(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_VIEW, P.USERS_MANAGE)), db: Session = Depends(get_db)):
    return svc.get_user_role(db, p, user_id)


@router.put("/users/{user_id}/role", response_model=UserRoleOut)
def put_user_role(user_id: uuid.UUID, data: RoleAssign, p: Principal = Depends(require_perm(P.USERS_MANAGE)), db: Session = Depends(get_db)):
    return svc.assign_role(db, p, user_id, data)


@router.get("/users/{user_id}/outlets", response_model=UserOutletAccessOut)
def get_user_outlets(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_VIEW, P.USERS_MANAGE)), db: Session = Depends(get_db)):
    return svc.user_outlet_access(db, p, user_id)


@router.put("/users/{user_id}/outlets", response_model=UserOutletAccessOut)
def put_user_outlets(user_id: uuid.UUID, data: OutletAccessIn,
                     p: Principal = Depends(require_perm(P.USERS_MANAGE, P.STAFF_MANAGE_OUTLET_ACCESS)), db: Session = Depends(get_db)):
    """Replaces the user's outlet grants (empty list = default outlet only)."""
    return svc.set_user_outlet_access(db, p, user_id, data.outlet_ids)
