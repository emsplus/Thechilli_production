"""All tables. Money is integer minor units (paise, INR); timestamps are timezone-aware UTC."""
import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


def now() -> datetime:
    return datetime.now(UTC)


def uid() -> uuid.UUID:
    return uuid.uuid4()


class OrderStatus(str, enum.Enum):
    NEEDS_MAPPING = "needs_mapping"  # at least one item has no internal mapping; cannot be accepted
    RECEIVED = "received"
    ACCEPTED = "accepted"
    READY = "ready"
    DISPATCHED = "dispatched"
    DELIVERED = "delivered"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


class StoreMapping(Base):
    """(provider, external_store_id) -> (tenant, outlet). Inbound webhooks are routed only through this."""
    __tablename__ = "store_mappings"
    __table_args__ = (
        UniqueConstraint("tenant_id", "provider", "external_store_id"),
        UniqueConstraint("tenant_id", "outlet_id", "provider"),
        # Ownership is exclusive only once PROVEN: unverified claims never block anyone (no squatting).
        Index("uq_store_verified_owner", "provider", "external_store_id", unique=True,
              postgresql_where=text("verified")))
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    outlet_id: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(32))
    external_store_id: Mapped[str] = mapped_column(String(128))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    webhook_secret_ref: Mapped[str] = mapped_column(String(64))  # NAME of an env var in the tenant's namespace
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verification_code: Mapped[str | None] = mapped_column(String(64))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class WebhookReplay(Base):
    """Signatures already accepted inside the timestamp window; pruned after 2x the window."""
    __tablename__ = "webhook_replays"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256(mapping|timestamp|signature)
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class MenuMapping(Base):
    __tablename__ = "menu_mappings"
    __table_args__ = (UniqueConstraint("tenant_id", "outlet_id", "provider", "external_item_id"),
                      Index("ix_menu_internal", "tenant_id", "outlet_id", "internal_item_id"))
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    outlet_id: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(32))
    external_item_id: Mapped[str] = mapped_column(String(128))
    internal_item_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class InboundEvent(Base):
    """Every signature-verified webhook is kept verbatim, including ones we could not turn into an order."""
    __tablename__ = "inbound_events"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    external_order_id: Mapped[str | None] = mapped_column(String(128))
    external_store_id: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16))  # ingested | duplicate | unroutable | invalid
    payload: Mapped[dict] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (UniqueConstraint("tenant_id", "provider", "external_order_id"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    outlet_id: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    external_order_id: Mapped[str] = mapped_column(String(128))
    external_store_id: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default=OrderStatus.RECEIVED.value, index=True)
    fulfilment_type: Mapped[str] = mapped_column(String(16), default="delivery")
    customer_name: Mapped[str | None] = mapped_column(String(200))
    customer_phone: Mapped[str | None] = mapped_column(String(32))
    notes: Mapped[str | None] = mapped_column(Text)
    currency: Mapped[str] = mapped_column(String(3))
    subtotal_minor: Mapped[int] = mapped_column(BigInteger)
    tax_minor: Mapped[int] = mapped_column(BigInteger, default=0)
    delivery_fee_minor: Mapped[int] = mapped_column(BigInteger, default=0)
    discount_minor: Mapped[int] = mapped_column(BigInteger, default=0)
    total_minor: Mapped[int] = mapped_column(BigInteger)
    placed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload_sha256: Mapped[str] = mapped_column(String(64))
    raw_payload: Mapped[dict] = mapped_column(JSONB)
    # Delivery to pos-service: none | pending | delivered | rejected
    pos_state: Mapped[str] = mapped_column(String(16), default="none")
    pos_order_id: Mapped[str | None] = mapped_column(String(64))
    pos_reject_code: Mapped[str | None] = mapped_column(String(64))
    pos_reject_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    items: Mapped[list["OrderItem"]] = relationship(back_populates="order", cascade="all, delete-orphan",
                                                    order_by="OrderItem.line_no")


class OrderItem(Base):
    __tablename__ = "order_items"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    external_item_id: Mapped[str] = mapped_column(String(128))
    internal_item_id: Mapped[str | None] = mapped_column(String(64))  # NULL = unmapped, kept and flagged
    name: Mapped[str] = mapped_column(String(300))
    quantity: Mapped[int] = mapped_column(Integer)
    unit_price_minor: Mapped[int] = mapped_column(BigInteger)
    order: Mapped[Order] = relationship(back_populates="items")


class OrderEvent(Base):
    __tablename__ = "order_events"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    from_status: Mapped[str | None] = mapped_column(String(16))
    to_status: Mapped[str] = mapped_column(String(16))
    actor: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str | None] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OutboundJob(Base):
    """Retry queue (transactional outbox) for everything we push out: provider status/menu/availability, pos delivery."""
    __tablename__ = "outbound_jobs"
    __table_args__ = (Index("ix_jobs_due", "status", "next_attempt_at"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    idempotency_key: Mapped[str] = mapped_column(String(256), unique=True)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # push_status | menu_sync | set_availability | deliver_to_pos
    provider: Mapped[str] = mapped_column(String(32))
    order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | done | dead
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class Payout(Base):
    __tablename__ = "payouts"
    __table_args__ = (UniqueConstraint("tenant_id", "provider", "external_payout_id"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    external_payout_id: Mapped[str] = mapped_column(String(128))
    currency: Mapped[str] = mapped_column(String(3))
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    gross_minor: Mapped[int] = mapped_column(BigInteger)
    commission_minor: Mapped[int] = mapped_column(BigInteger)
    fees_minor: Mapped[int] = mapped_column(BigInteger, default=0)
    net_minor: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(16), default="imported")  # imported | reconciled | discrepancy
    discrepancies: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    lines: Mapped[list["PayoutLine"]] = relationship(back_populates="payout", cascade="all, delete-orphan")


class PayoutLine(Base):
    __tablename__ = "payout_lines"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    payout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payouts.id", ondelete="CASCADE"), index=True)
    external_order_id: Mapped[str] = mapped_column(String(128))
    order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    gross_minor: Mapped[int] = mapped_column(BigInteger)
    commission_minor: Mapped[int] = mapped_column(BigInteger)
    net_minor: Mapped[int] = mapped_column(BigInteger)
    match_status: Mapped[str] = mapped_column(String(24), default="unmatched")  # matched | amount_mismatch | order_not_found
    payout: Mapped[Payout] = relationship(back_populates="lines")


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    tenant_id: Mapped[str | None] = mapped_column(String(64), index=True)
    actor: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(32))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(JSONB, default=dict)
