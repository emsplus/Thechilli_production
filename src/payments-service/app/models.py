import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

STATUSES = ("created", "pending", "succeeded", "failed", "refunded", "partially_refunded")


def _id():
    return mapped_column(Uuid, primary_key=True, default=uuid.uuid4)


def _now():
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ProviderAccount(Base):
    """Per-tenant provider config. Holds only NAMES of env vars (secret references), never key material."""
    __tablename__ = "provider_accounts"
    id: Mapped[uuid.UUID] = _id()
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    key_id_ref: Mapped[str] = mapped_column(String(64))
    key_secret_ref: Mapped[str] = mapped_column(String(64))
    webhook_secret_ref: Mapped[str] = mapped_column(String(64))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _now()


class PaymentIntent(Base):
    __tablename__ = "payment_intents"
    __table_args__ = (
        UniqueConstraint("tenant_id", "idempotency_key"),
        CheckConstraint("amount > 0"),
        CheckConstraint("refunded_amount >= 0 AND refunded_amount <= captured_amount"),
        CheckConstraint("status IN ('created','pending','succeeded','failed','refunded','partially_refunded')"),
        Index("ix_intent_provider_ref", "provider_account_id", "provider_ref"),
        Index("ix_intent_provider_payment", "tenant_id", "provider_payment_id"),
    )
    id: Mapped[uuid.UUID] = _id()
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    provider_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("provider_accounts.id"))
    method: Mapped[str] = mapped_column(String(16))  # upi_qr | payment_link
    reference: Mapped[str] = mapped_column(String(64))  # caller's order id
    amount: Mapped[int] = mapped_column(BigInteger)  # minor units (paise)
    currency: Mapped[str] = mapped_column(String(3))
    description: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(24), default="created")
    provider_ref: Mapped[str | None] = mapped_column(String(64))
    provider_payment_id: Mapped[str | None] = mapped_column(String(64))
    payment_url: Mapped[str | None] = mapped_column(String(512))
    qr_payload: Mapped[str | None] = mapped_column(String(1024))
    captured_amount: Mapped[int] = mapped_column(BigInteger, default=0)
    refunded_amount: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = (UniqueConstraint("tenant_id", "idempotency_key"), CheckConstraint("amount > 0"),
                      CheckConstraint("status IN ('pending','succeeded','failed')"),
                      CheckConstraint("kind IN ('intent','unallocated')"))
    id: Mapped[uuid.UUID] = _id()
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    intent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payment_intents.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    amount: Mapped[int] = mapped_column(BigInteger)
    reason: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    provider_refund_id: Mapped[str | None] = mapped_column(String(64), index=True)
    # Deterministic (derived from tenant + idempotency key) and sent to the provider, so an unknown outcome
    # (timeout) can be reconciled by looking the refund up by receipt instead of blindly re-creating it.
    receipt: Mapped[str | None] = mapped_column(String(40))
    # 'intent' = refund of the intent's own captured payment; 'unallocated' = return of money that never settled an
    # intent (under/over/extra payment). provider_payment_id is the payment being refunded (NULL = the intent's).
    kind: Mapped[str] = mapped_column(String(16), default="intent", server_default="intent")
    provider_payment_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = _now()


class WebhookEvent(Base):
    __tablename__ = "webhook_events"
    # Duplicate-delivery protection. X-Razorpay-Event-Id is NOT covered by the signature, so the sha256 of the signed
    # body is the authoritative dedupe key; the header id is kept as a second, weaker key.
    __table_args__ = (UniqueConstraint("provider_account_id", "event_id"),
                      UniqueConstraint("provider_account_id", "body_hash"))
    id: Mapped[uuid.UUID] = _id()
    provider_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("provider_accounts.id"))
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    event_id: Mapped[str] = mapped_column(String(128))
    event_type: Mapped[str] = mapped_column(String(48))
    outcome: Mapped[str] = mapped_column(String(32), default="")  # 'unmatched' = held for reprocessing, not consumed
    body_hash: Mapped[str | None] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    payload: Mapped[dict] = mapped_column(JSON)  # scrubbed of card fields
    received_at: Mapped[datetime] = _now()


class LedgerEntry(Base):
    """Append-only (DB trigger blocks UPDATE/DELETE). Signed: payments +, refunds -."""
    __tablename__ = "ledger_entries"
    __table_args__ = (CheckConstraint("entry_type IN ('payment','refund','unallocated','unallocated_refund')"),
                      UniqueConstraint("tenant_id", "entry_type", "provider_txn_id"))
    id: Mapped[uuid.UUID] = _id()
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    intent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payment_intents.id"), index=True)
    entry_type: Mapped[str] = mapped_column(String(24))
    amount: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    provider_txn_id: Mapped[str] = mapped_column(String(64))
    evidence_event_id: Mapped[str | None] = mapped_column(String(128))  # webhook event id, or "sync:<id>"
    created_at: Mapped[datetime] = _now()


class AuditLog(Base):
    """Append-only (DB trigger blocks UPDATE/DELETE/TRUNCATE)."""
    __table_args__ = (Index("ix_audit_tenant_action_created", "tenant_id", "action", "created_at"),)
    __tablename__ = "audit_log"
    id: Mapped[uuid.UUID] = _id()
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    actor: Mapped[str] = mapped_column(String(32))  # service | webhook | provider_sync
    action: Mapped[str] = mapped_column(String(48))
    intent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = _now()


class Settlement(Base):
    __tablename__ = "settlements"
    __table_args__ = (UniqueConstraint("tenant_id", "provider", "settlement_ref"),)
    id: Mapped[uuid.UUID] = _id()
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    settlement_ref: Mapped[str] = mapped_column(String(64))
    settled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class ReconciliationRecord(Base):
    __tablename__ = "reconciliation_records"
    __table_args__ = (UniqueConstraint("settlement_id", "item_type", "provider_txn_id"),
                      CheckConstraint("status IN ('matched','unmatched','amount_mismatch')"))
    id: Mapped[uuid.UUID] = _id()
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    settlement_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("settlements.id"), index=True)
    item_type: Mapped[str] = mapped_column(String(16))  # payment | refund
    provider_txn_id: Mapped[str] = mapped_column(String(64))
    amount: Mapped[int] = mapped_column(BigInteger)  # gross, minor units
    fee: Mapped[int] = mapped_column(BigInteger, default=0)
    tax: Mapped[int] = mapped_column(BigInteger, default=0)
    intent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(String(20))
    expected_amount: Mapped[int | None] = mapped_column(BigInteger)
    matched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
