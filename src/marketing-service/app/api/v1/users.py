import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import ADMIN, Principal, require_roles, read_roles
from app.core.db import get_db
from app.core.security import hash_password, utcnow
from app.models import MarketingUser, RefreshToken, Role
from app.schemas.api import UserCreate, UserOut, UserUpdate
from app.services import audit

router = APIRouter(prefix="/users", tags=["users"])


@router.post("", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, p: Principal = Depends(require_roles(*ADMIN)), db: Session = Depends(get_db)):
    u = MarketingUser(email=body.email.lower(), name=body.name, role=body.role, password_hash=hash_password(body.password))
    db.add(u)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A user with this email already exists")
    audit.record(db, p.user_id, "user.created", "marketing_user", u.id, {"role": u.role.value})
    db.commit()
    return u


@router.get("", response_model=list[UserOut])
def list_users(role: Role | None = None, p: Principal = Depends(read_roles(*ADMIN)), db: Session = Depends(get_db)):
    q = select(MarketingUser).order_by(MarketingUser.created_at)
    if role:
        q = q.where(MarketingUser.role == role)
    return list(db.scalars(q))


@router.get("/{user_id}", response_model=UserOut)
def get_user(user_id: uuid.UUID, p: Principal = Depends(require_roles(*ADMIN)), db: Session = Depends(get_db)):
    u = db.get(MarketingUser, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    return u


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: uuid.UUID, body: UserUpdate, p: Principal = Depends(require_roles(*ADMIN)),
                db: Session = Depends(get_db)):
    u = db.get(MarketingUser, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    data = body.model_dump(exclude_unset=True)
    if u.id == p.user_id and (data.get("is_active") is False or ("role" in data and data["role"] != u.role)):
        raise HTTPException(409, "You cannot deactivate or change the role of your own account")
    changed = [k for k in data if k != "password"]
    if "password" in data:
        u.password_hash = hash_password(data.pop("password"))
        changed.append("password")
    for k, v in data.items():
        if v is not None:
            setattr(u, k, v)
    if data.get("is_active") is False or "password" in changed:
        db.execute(update(RefreshToken).where(RefreshToken.user_id == u.id, RefreshToken.revoked_at.is_(None))
                   .values(revoked_at=utcnow()))
    audit.record(db, p.user_id, "user.updated", "marketing_user", u.id, {"fields": changed})
    db.commit()
    return u
