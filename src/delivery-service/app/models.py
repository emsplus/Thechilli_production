import uuid
from datetime import datetime
from typing import ClassVar

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

ORDER_STATUSES = ("placed", "accepted", "preparing", "ready", "out_for_delivery", "delivered", "cancelled")
RANK = {s: i for i, s in enumerate(ORDER_STATUSES[:-1])}
TERMINAL = ("delivered", "cancelled")


def _id():
    return mapped_column(Uuid, primary_key=True, default=uuid.uuid4)


def _now():
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Restaurant(Base):
    """Per-restaurant config. Holds only NAMES of env vars (secret references), never key material."""
    __tablename__ = "restaurants"
    restaurant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    brand_name: Mapped[str] = mapped_column(String(120), default="")
    payment_qr_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    pos_webhook_secret_ref: Mapped[str] = mapped_column(String(64))  # verifies POS -> delivery webhooks
    pos_api_key_ref: Mapped[str] = mapped_column(String(64))  # credential delivery -> POS
    created_at: Mapped[datetime] = _now()


class ChannelNumber(Base):
    """WhatsApp phone_number_id -> restaurant. The ONLY way inbound traffic is attributed to a tenant."""
    __tablename__ = "channel_numbers"
    phone_number_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    restaurant_id: Mapped[str] = mapped_column(String(64), index=True)
    display_number: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = _now()


class Rider(Base):
    """Riders and managers are delivery-service rows (role), not POS users."""
    __tablename__ = "riders"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(32))
    role: Mapped[str] = mapped_column(String(16), default="rider")  # rider | manager
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    outlet_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = _now()
    __table_args__ = (UniqueConstraint("restaurant_id", "phone", "role"),)


class DeliveryOrder(Base):
    __tablename__ = "delivery_orders"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64))
    client_uuid: Mapped[str] = mapped_column(String(64))
    channel: Mapped[str] = mapped_column(String(16), default="web")
    pos_order_id: Mapped[str] = mapped_column(String(64))
    order_code: Mapped[str] = mapped_column(String(32), default="")
    status: Mapped[str] = mapped_column(String(24), default="placed")
    pos_version: Mapped[int] = mapped_column(Integer, default=0)
    customer_name: Mapped[str] = mapped_column(String(120), default="")
    wa_number: Mapped[str] = mapped_column(String(32))
    address_text: Mapped[str] = mapped_column(Text, default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Money in minor units, copied from the POS response. Never computed here.
    subtotal: Mapped[int] = mapped_column(BigInteger, default=0)
    delivery_fee: Mapped[int] = mapped_column(BigInteger, default=0)
    tax: Mapped[int] = mapped_column(BigInteger, default=0)
    total: Mapped[int] = mapped_column(BigInteger, default=0)
    payment_mode: Mapped[str] = mapped_column(String(8), default="cod")
    claimed_paid: Mapped[bool] = mapped_column(Boolean, default=False)  # a claim, never proof
    payment_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)  # only set by POS webhook
    offered_rider_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("riders.id"), nullable=True)
    rider_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("riders.id"), nullable=True)
    otp_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    otp_rider_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    otp_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    otp_tries: Mapped[int] = mapped_column(Integer, default=0)
    otp_locked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _now()
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__ = (UniqueConstraint("restaurant_id", "client_uuid"),
                      UniqueConstraint("restaurant_id", "pos_order_id"),
                      Index("ix_orders_rest_status", "restaurant_id", "status"))


class RiderDecline(Base):
    __tablename__ = "rider_declines"
    id: Mapped[uuid.UUID] = _id()
    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("delivery_orders.id"), index=True)
    rider_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("riders.id"))
    __table_args__ = (UniqueConstraint("order_id", "rider_id"),)


class RiderLocation(Base):
    """Latest ping only, no history. Reads ignore rows older than the TTL."""
    __tablename__ = "rider_locations"
    rider_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("riders.id"), primary_key=True)
    restaurant_id: Mapped[str] = mapped_column(String(64))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class OrderEvent(Base):
    __tablename__ = "order_events"
    id: Mapped[uuid.UUID] = _id()
    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("delivery_orders.id"), index=True)
    restaurant_id: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(48))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = _now()


class ProcessedPosEvent(Base):
    """Dedup of POS webhook event ids."""
    __tablename__ = "processed_pos_events"
    restaurant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    event_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    created_at: Mapped[datetime] = _now()


class InboundMessage(Base):
    """Inbound WhatsApp messages; unique provider id = dedup."""
    __tablename__ = "inbound_messages"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64))
    provider_message_id: Mapped[str] = mapped_column(String(128))
    wa_number: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = _now()
    __table_args__ = (UniqueConstraint("restaurant_id", "provider_message_id"),)


class UnprocessedInbound(Base):
    """Webhook deliveries for an unknown phone_number_id: answered 200, recorded here, never processed."""
    __tablename__ = "unprocessed_inbound"
    id: Mapped[uuid.UUID] = _id()
    phone_number_id: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = _now()


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64))
    wa_number: Mapped[str] = mapped_column(String(32))
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = _now()
    __table_args__ = (UniqueConstraint("restaurant_id", "wa_number"),)


class OutboundMessage(Base):
    """Outbound queue: retry with backoff, dead-letter after N attempts (status=dead)."""
    __tablename__ = "outbound_messages"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64))
    order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    to_number: Mapped[str] = mapped_column(String(32))
    template: Mapped[str] = mapped_column(String(48))
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    text: Mapped[str] = mapped_column(Text, default="")
    sensitive: Mapped[bool] = mapped_column(Boolean, default=False)  # redacted after a successful send
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)  # pending|sent|dead
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = _now()
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_message_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = _now()


class OutboxJob(Base):
    """Calls to pos-service written in the same transaction as the state change (dispatch, delivered, cancel)."""
    __tablename__ = "outbox_jobs"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64))
    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("delivery_orders.id"))
    kind: Mapped[str] = mapped_column(String(16))  # dispatch | delivered | cancel
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)  # pending|done|dead
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = _now()
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _now()
    __table_args__ = (UniqueConstraint("order_id", "kind"),)  # idempotent by (order, status)


class Reminder(Base):
    """DB-backed due-time scheduler; survives broker/Redis loss."""
    __tablename__ = "reminders"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64))
    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("delivery_orders.id"), index=True)
    stage: Mapped[int] = mapped_column(Integer)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    done: Mapped[bool] = mapped_column(Boolean, default=False)
    __table_args__ = (UniqueConstraint("order_id", "stage"),)


class RevokedToken(Base):
    """Individually revoked signed tokens (by jti). Rows can be purged after expires_at: the token is dead anyway."""
    __tablename__ = "revoked_tokens"
    restaurant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    jti: Mapped[str] = mapped_column(String(32), primary_key=True)
    aud: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = _now()
    __table_args__: ClassVar[dict] = {"info": {"revision": "0003"}}


class RateBucket(Base):
    """Token bucket per (restaurant, key); key = 'send:<phone_number_id>' (per sender number) or 'to:<recipient>'."""
    __tablename__ = "rate_buckets"
    restaurant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    key: Mapped[str] = mapped_column(String(96), primary_key=True)
    tokens: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    __table_args__: ClassVar[dict] = {"info": {"revision": "0004"}}


class WaConsent(Base):
    """WhatsApp opt-out state per number (STOP / START keywords)."""
    __tablename__ = "wa_consents"
    restaurant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    wa_number: Mapped[str] = mapped_column(String(32), primary_key=True)
    opted_out: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = _now()
    __table_args__: ClassVar[dict] = {"info": {"revision": "0004"}}


class MessageStatus(Base):
    """Delivery receipts from the provider webhook (sent / delivered / read / failed), one row per (message, status)."""
    __tablename__ = "message_statuses"
    id: Mapped[uuid.UUID] = _id()
    restaurant_id: Mapped[str] = mapped_column(String(64))
    provider_message_id: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16))
    recipient: Mapped[str] = mapped_column(String(32), default="")
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    error_title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = _now()
    __table_args__ = (UniqueConstraint("restaurant_id", "provider_message_id", "status"),
                      {"info": {"revision": "0004"}})


class OrderRating(Base):
    """Customer rating (1-5) after delivery, asked over WhatsApp; one per order."""
    __tablename__ = "order_ratings"
    restaurant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("delivery_orders.id"), primary_key=True)
    rating: Mapped[int] = mapped_column(Integer)
    feedback: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = _now()
    __table_args__: ClassVar[dict] = {"info": {"revision": "0005"}}


class PublicLink(Base):
    """One stable public ordering link per restaurant: https://<host>/r/<slug>. The slug is an unguessable capability (~59 bits),
    rotated or switched off by the owner (docs/PUBLIC_ORDER_LINK.md). Looked up before the tenant is known through the
    SECURITY DEFINER function resolve_public_link(slug), which only answers for an enabled link."""
    __tablename__ = "public_links"
    restaurant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    slug: Mapped[str] = mapped_column(String(32), unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    brand_color: Mapped[str | None] = mapped_column(String(7), nullable=True)  # #RRGGBB, owner brand colour
    created_at: Mapped[datetime] = _now()
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __table_args__: ClassVar[dict] = {"info": {"revision": "0006"}}
