import uuid
from datetime import datetime
from typing import Any

from fastapi import Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import errors

HIDDEN = {"password_hash", "token_hash", "key_hash", "submitter_ip_hash"}


def to_dict(obj, exclude: set[str] = frozenset()) -> dict:
    out = {}
    for c in obj.__table__.columns:
        if c.key in HIDDEN or c.key in exclude:
            continue
        v = getattr(obj, c.key)
        out[c.key] = str(v) if isinstance(v, uuid.UUID) else (v.isoformat() if isinstance(v, datetime) else v)
    return out


class Page:
    def __init__(self, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
        self.limit, self.offset = limit, offset


def paged(db: Session, stmt, page: Page, model, ordering, exclude=frozenset()) -> dict:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    rows = db.scalars(stmt.order_by(*ordering if isinstance(ordering, (list, tuple)) else [ordering])
                      .limit(page.limit).offset(page.offset)).all()
    return {"items": [to_dict(r, exclude) for r in rows], "total": total, "limit": page.limit, "offset": page.offset}


def get_or_404(db: Session, model, ident, what: str | None = None):
    try:
        obj = db.get(model, ident)
    except Exception:
        obj = None
    if obj is None:
        raise errors.not_found(f"{what or model.__name__} not found")
    return obj


def parse_uuid(v: str, what="id") -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except ValueError:
        raise errors.not_found(f"{what} not found")


def snap(obj, *fields) -> dict:
    return {f: getattr(obj, f) for f in fields}


def ok(**kw) -> dict:
    return {"ok": True, **kw}


Any  # noqa
