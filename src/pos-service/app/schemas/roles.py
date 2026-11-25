import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.core import Role


def _clean_name(v: str) -> str:
    v = " ".join(v.split())
    if not v:
        raise ValueError("name must not be blank")
    return v


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    permissions: list[str] = Field(default_factory=list, max_length=200)

    _name = field_validator("name")(_clean_name)


class RolePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    permissions: list[str] | None = Field(default=None, max_length=200)
    is_active: bool | None = None

    @field_validator("name")
    @classmethod
    def _n(cls, v):
        return None if v is None else _clean_name(v)

    @model_validator(mode="after")
    def _non_null(self):
        if self.name is None and self.permissions is None and self.is_active is None:
            raise ValueError("nothing to change")
        return self


class RoleClone(BaseModel):
    names: list[str] = Field(min_length=1, max_length=20)

    @field_validator("names")
    @classmethod
    def _names(cls, v):
        v = [_clean_name(x) for x in v]
        if any(len(x) > 100 for x in v):
            raise ValueError("name too long")
        return v


class OutletEffect(BaseModel):
    access_all: bool
    effect: str


class PermissionSnapshot(BaseModel):
    count: int
    by_area: dict[str, list[str]]
    outlets: OutletEffect


class RoleOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    is_system: bool
    is_active: bool
    editable: bool
    permissions: list[str]
    permission_snapshot: PermissionSnapshot
    user_count: int
    created_at: datetime | None = None


class RoleAssign(BaseModel):
    """Exactly one of `role` (a built-in role: owner manager cashier waiter kitchen) or `role_id` (id of a role from GET /roles,
    system or custom)."""
    role: Role | None = None
    role_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _one(self):
        if (self.role is None) == (self.role_id is None):
            raise ValueError("send exactly one of role or role_id")
        return self


class UserRoleOut(BaseModel):
    user_id: uuid.UUID
    email: str | None  # staff added by phone / username have no email
    full_name: str
    is_active: bool
    role: Role  # the built-in role column; ignored for permissions while custom_role_id is set
    custom_role_id: uuid.UUID | None
    effective_role: RoleOut


class UserOutletAccessOut(BaseModel):
    outlet_ids: list[uuid.UUID]  # explicit grants (user_outlet_access)
    access_all: bool  # the user's role holds outlets.access_all: grants are ignored
    effective_outlet_ids: list[uuid.UUID]  # what the user can actually reach
    note: str
