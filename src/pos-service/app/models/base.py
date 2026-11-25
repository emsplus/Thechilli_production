import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import UUID

from app.core.db import Base


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def fk(table: str, nullable: bool = False) -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), ForeignKey(f"{table}.id"), nullable=nullable, index=True)


def outlet_col(nullable: bool = False) -> Mapped[uuid.UUID]:
    """Outlet of an outlet-scoped row (docs/OUTLETS.md). The composite FK (outlet_id, restaurant_id) -> outlets is attached
    in models/core.py (`OUTLET_TABLES`), so an outlet of another tenant is impossible at the database level."""
    return mapped_column(UUID(as_uuid=True), nullable=nullable, index=True)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


__all__ = ["Base", "uuid_pk", "fk", "outlet_col", "TimestampMixin"]
