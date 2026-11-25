import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Tenant


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    return s or "tenant"


def unique_slug(db: Session, name: str) -> str:
    base = slugify(name)
    slug = base
    while db.scalar(select(Tenant.id).where(Tenant.slug == slug)):
        slug = f"{base}-{secrets.token_hex(2)}"
    return slug
