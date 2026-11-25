"""Provisioning tables (docs/PROVISIONING.md).

`provisioning_requests` is GLOBAL (no tenant column, exempt from RLS, like abuse_counters): the idempotency ledger of the
service-principal endpoint that CREATES tenants, looked up by the hash of the caller's Idempotency-Key before any tenant is
bound. `user_invites` is a tenant table (RLS): the single-use "set your password" invite of a provisioned owner.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import fk, uuid_pk
from app.core.db import Base


class ProvisioningRequest(Base):
    __tablename__ = "provisioning_requests"
    id: Mapped[uuid.UUID] = uuid_pk()
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)  # sha256 of the Idempotency-Key (the key is never stored)
    request_hash: Mapped[str] = mapped_column(String(64))  # sha256 of the canonical request body: same key + other body = 409
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True)  # = restaurants.id; no FK: this table is not tenant data
    plan_code: Mapped[str | None] = mapped_column(String(64))
    hints: Mapped[dict | None] = mapped_column(JSONB)  # entitlement hints, informational only (platform-core is authoritative)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserInvite(Base):
    __tablename__ = "user_invites"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)  # sha256 of the secret part of the token only
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # single use: set once, atomically
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # replaced by a newer invite
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
