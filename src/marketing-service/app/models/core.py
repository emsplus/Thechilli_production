"""All tables. Data boundary: marketing/onboarding data only. There is deliberately no table or column for orders,
payments, restaurant customers, restaurant employees or menu contents (tests/test_boundary.py enforces this)."""
import enum
import uuid
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.security import utcnow
from app.models.enums import (BUSINESS_TYPES_CHECK, ActivityType, AppSource, AppStatus, Calc, CampaignStatus, ChecklistKey, ChecklistStatus,
                              DeliveryStatus, DemoStatus, DocStatus, EntryKind, EntryStatus, LeadStage, Recipient, Role)


def E(e: type[enum.Enum]):
    return sa.Enum(e, native_enum=False, length=32, validate_strings=True, values_callable=lambda x: [i.value for i in x])


def _id():
    return mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)


def _ts():
    return mapped_column(sa.DateTime(timezone=True), default=utcnow)


UUIDfk = lambda target, **kw: mapped_column(sa.Uuid, sa.ForeignKey(target), **kw)  # noqa: E731


class MarketingUser(Base):
    __tablename__ = "marketing_users"
    id: Mapped[uuid.UUID] = _id()
    email: Mapped[str] = mapped_column(sa.String(254), unique=True)
    name: Mapped[str] = mapped_column(sa.String(120))
    password_hash: Mapped[str] = mapped_column(sa.String(255))
    role: Mapped[Role] = mapped_column(E(Role))
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = _ts()


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = UUIDfk("marketing_users.id", index=True)
    token_hash: Mapped[str] = mapped_column(sa.String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[uuid.UUID] = _id()
    email: Mapped[str] = mapped_column(sa.String(254), index=True)
    ip: Mapped[str | None] = mapped_column(sa.String(64), index=True)  # client IP (security review finding 4)
    at: Mapped[datetime] = _ts()


class Campaign(Base):
    __tablename__ = "campaigns"
    id: Mapped[uuid.UUID] = _id()
    name: Mapped[str] = mapped_column(sa.String(120), unique=True)
    channel: Mapped[str] = mapped_column(sa.String(40))
    status: Mapped[CampaignStatus] = mapped_column(E(CampaignStatus), default=CampaignStatus.draft)
    budget_minor: Mapped[int] = mapped_column(sa.BigInteger, default=0)
    currency: Mapped[str] = mapped_column(sa.String(3))
    starts_on: Mapped[date | None]
    ends_on: Mapped[date | None]
    created_by: Mapped[uuid.UUID] = UUIDfk("marketing_users.id")
    created_at: Mapped[datetime] = _ts()
    __table_args__ = (sa.CheckConstraint("budget_minor >= 0", name="ck_campaign_budget"),)


class ReferralCode(Base):
    __tablename__ = "referral_codes"
    id: Mapped[uuid.UUID] = _id()
    code: Mapped[str] = mapped_column(sa.String(32), unique=True)
    owner_id: Mapped[uuid.UUID] = UUIDfk("marketing_users.id", index=True)
    campaign_id: Mapped[uuid.UUID | None] = UUIDfk("campaigns.id", nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    max_uses: Mapped[int | None]
    expires_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()


class Lead(Base):
    __tablename__ = "leads"
    id: Mapped[uuid.UUID] = _id()
    business_name: Mapped[str] = mapped_column(sa.String(160))
    contact_name: Mapped[str] = mapped_column(sa.String(120))
    phone: Mapped[str | None] = mapped_column(sa.String(40))
    phone_norm: Mapped[str | None] = mapped_column(sa.String(20), index=True)
    email: Mapped[str | None] = mapped_column(sa.String(254))
    email_norm: Mapped[str | None] = mapped_column(sa.String(254), index=True)
    city: Mapped[str | None] = mapped_column(sa.String(80))
    business_type: Mapped[str | None] = mapped_column(sa.String(40))  # descriptive kind for the pipeline (cafe, bakery, ...)
    business_types: Mapped[list | None] = mapped_column(JSONB)  # platform selection when captured (public lead form)
    source: Mapped[str] = mapped_column(sa.String(40), default="manual")
    stage: Mapped[LeadStage] = mapped_column(E(LeadStage), default=LeadStage.new, index=True)
    lost_reason: Mapped[str | None] = mapped_column(sa.String(255))
    notes: Mapped[str | None] = mapped_column(sa.Text)
    owner_id: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True, index=True)
    campaign_id: Mapped[uuid.UUID | None] = UUIDfk("campaigns.id", nullable=True, index=True)
    referral_code_id: Mapped[uuid.UUID | None] = UUIDfk("referral_codes.id", nullable=True)
    created_by: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Activity(Base):
    __tablename__ = "activities"
    id: Mapped[uuid.UUID] = _id()
    lead_id: Mapped[uuid.UUID] = UUIDfk("leads.id", index=True)
    type: Mapped[ActivityType] = mapped_column(E(ActivityType))
    summary: Mapped[str] = mapped_column(sa.String(500))
    due_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True), index=True)
    completed_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    assignee_id: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True)
    created_by: Mapped[uuid.UUID] = UUIDfk("marketing_users.id")
    created_at: Mapped[datetime] = _ts()


class Demo(Base):
    __tablename__ = "demos"
    id: Mapped[uuid.UUID] = _id()
    lead_id: Mapped[uuid.UUID] = UUIDfk("leads.id", index=True)
    assignee_id: Mapped[uuid.UUID] = UUIDfk("marketing_users.id", index=True)
    scheduled_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    duration_minutes: Mapped[int] = mapped_column(default=30)
    mode: Mapped[str] = mapped_column(sa.String(20), default="online")  # online | on_site
    location: Mapped[str | None] = mapped_column(sa.String(255))
    status: Mapped[DemoStatus] = mapped_column(E(DemoStatus), default=DemoStatus.scheduled)
    outcome_notes: Mapped[str | None] = mapped_column(sa.Text)
    created_by: Mapped[uuid.UUID] = UUIDfk("marketing_users.id")
    created_at: Mapped[datetime] = _ts()
    __table_args__ = (sa.CheckConstraint("duration_minutes > 0", name="ck_demo_duration"),)


class OnboardingApplication(Base):
    __tablename__ = "onboarding_applications"
    id: Mapped[uuid.UUID] = _id()
    lead_id: Mapped[uuid.UUID | None] = UUIDfk("leads.id", nullable=True, index=True)
    agent_id: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True, index=True)
    source: Mapped[AppSource] = mapped_column(E(AppSource), default=AppSource.assisted)
    status: Mapped[AppStatus] = mapped_column(E(AppStatus), default=AppStatus.draft, index=True)
    business_name: Mapped[str] = mapped_column(sa.String(160))
    # platform selection forwarded to platform-core: one or more of restaurant | cloud_kitchen | hotel_kitchen
    business_types: Mapped[list] = mapped_column(JSONB, default=lambda: ["restaurant"],
                                                 server_default=sa.text("'[\"restaurant\"]'::jsonb"))
    owner_name: Mapped[str | None] = mapped_column(sa.String(120))
    owner_email: Mapped[str | None] = mapped_column(sa.String(254))
    owner_phone: Mapped[str | None] = mapped_column(sa.String(40))
    referral_code_id: Mapped[uuid.UUID | None] = UUIDfk("referral_codes.id", nullable=True)
    invitation_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, nullable=True)
    contract_value_minor: Mapped[int] = mapped_column(sa.BigInteger, default=0)  # our own deal value, commission base
    currency: Mapped[str] = mapped_column(sa.String(3))
    external_business_id: Mapped[str | None] = mapped_column(sa.String(64), unique=True)  # opaque id from provisioning
    provisioning_error: Mapped[str | None] = mapped_column(sa.String(500))
    provisioned_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    platform_status: Mapped[str | None] = mapped_column(sa.String(24))  # activation state reported by platform-core
    billing_status: Mapped[str | None] = mapped_column(sa.String(24))  # subscription state reported by platform-core
    status_checked_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (sa.CheckConstraint("contract_value_minor >= 0", name="ck_app_value"),
                      sa.CheckConstraint(BUSINESS_TYPES_CHECK, name="ck_app_business_types"))


class ChecklistItem(Base):
    __tablename__ = "onboarding_checklist_items"
    id: Mapped[uuid.UUID] = _id()
    application_id: Mapped[uuid.UUID] = UUIDfk("onboarding_applications.id", index=True)
    key: Mapped[ChecklistKey] = mapped_column(E(ChecklistKey))
    status: Mapped[ChecklistStatus] = mapped_column(E(ChecklistStatus), default=ChecklistStatus.pending)
    data: Mapped[dict] = mapped_column(JSONB, default=dict)  # validated per key; summary/metadata only
    updated_by: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True)
    updated_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (sa.UniqueConstraint("application_id", "key", name="uq_checklist_app_key"),)


class SignupInvitation(Base):
    __tablename__ = "signup_invitations"
    id: Mapped[uuid.UUID] = _id()
    token_hash: Mapped[str] = mapped_column(sa.String(64), unique=True)
    email: Mapped[str] = mapped_column(sa.String(254))
    lead_id: Mapped[uuid.UUID | None] = UUIDfk("leads.id", nullable=True)
    application_id: Mapped[uuid.UUID | None] = UUIDfk("onboarding_applications.id", nullable=True)
    referral_code_id: Mapped[uuid.UUID | None] = UUIDfk("referral_codes.id", nullable=True)
    expires_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = UUIDfk("marketing_users.id")
    created_at: Mapped[datetime] = _ts()


class ReferralAttribution(Base):
    __tablename__ = "referral_attributions"
    id: Mapped[uuid.UUID] = _id()
    referral_code_id: Mapped[uuid.UUID] = UUIDfk("referral_codes.id", index=True)
    lead_id: Mapped[uuid.UUID | None] = UUIDfk("leads.id", nullable=True, unique=True)
    application_id: Mapped[uuid.UUID | None] = UUIDfk("onboarding_applications.id", nullable=True, unique=True)
    created_at: Mapped[datetime] = _ts()
    __table_args__ = (sa.CheckConstraint("lead_id IS NOT NULL OR application_id IS NOT NULL", name="ck_attr_target"),)


class CommissionRule(Base):
    __tablename__ = "commission_rules"
    id: Mapped[uuid.UUID] = _id()
    name: Mapped[str] = mapped_column(sa.String(120), unique=True)
    recipient: Mapped[Recipient] = mapped_column(E(Recipient))
    calc: Mapped[Calc] = mapped_column(E(Calc))
    flat_amount_minor: Mapped[int] = mapped_column(sa.BigInteger, default=0)
    rate_bps: Mapped[int] = mapped_column(default=0)  # basis points, 10000 = 100%
    cap_minor: Mapped[int | None] = mapped_column(sa.BigInteger)
    min_base_minor: Mapped[int] = mapped_column(sa.BigInteger, default=0)
    currency: Mapped[str] = mapped_column(sa.String(3))
    is_active: Mapped[bool] = mapped_column(default=True)
    valid_from: Mapped[date | None]
    valid_to: Mapped[date | None]
    created_by: Mapped[uuid.UUID] = UUIDfk("marketing_users.id")
    created_at: Mapped[datetime] = _ts()
    __table_args__ = (sa.CheckConstraint("flat_amount_minor >= 0 AND cap_minor >= 0 AND min_base_minor >= 0",
                                         name="ck_rule_money"),
                      sa.CheckConstraint("rate_bps BETWEEN 0 AND 10000", name="ck_rule_rate"))


class CommissionEntry(Base):
    """Append-only ledger. Amounts are integer minor units; reversals are new negative rows."""
    __tablename__ = "commission_entries"
    id: Mapped[uuid.UUID] = _id()
    kind: Mapped[EntryKind] = mapped_column(E(EntryKind), default=EntryKind.commission)
    rule_id: Mapped[uuid.UUID | None] = UUIDfk("commission_rules.id", nullable=True)
    user_id: Mapped[uuid.UUID] = UUIDfk("marketing_users.id", index=True)
    application_id: Mapped[uuid.UUID | None] = UUIDfk("onboarding_applications.id", nullable=True, index=True)
    lead_id: Mapped[uuid.UUID | None] = UUIDfk("leads.id", nullable=True)
    base_amount_minor: Mapped[int] = mapped_column(sa.BigInteger, default=0)
    amount_minor: Mapped[int] = mapped_column(sa.BigInteger)
    currency: Mapped[str] = mapped_column(sa.String(3))
    status: Mapped[EntryStatus] = mapped_column(E(EntryStatus), default=EntryStatus.pending, index=True)
    rule_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    reverses_entry_id: Mapped[uuid.UUID | None] = UUIDfk("commission_entries.id", nullable=True, unique=True)
    decided_by: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(sa.String(255))
    created_at: Mapped[datetime] = _ts()
    __table_args__ = (sa.UniqueConstraint("rule_id", "application_id", "user_id", name="uq_entry_rule_app_user"),)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[uuid.UUID] = _id()
    actor_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, index=True)  # no FK: log outlives users
    action: Mapped[str] = mapped_column(sa.String(60), index=True)
    entity_type: Mapped[str] = mapped_column(sa.String(40), index=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, index=True)
    meta: Mapped[dict | None] = mapped_column(JSONB)  # ids, field names and status changes only; never contact PII
    created_at: Mapped[datetime] = _ts()


class ApplicationDocument(Base):
    """Metadata for an uploaded onboarding document. Bytes live behind app.services.documents.DocumentStore."""
    __tablename__ = "application_documents"
    id: Mapped[uuid.UUID] = _id()
    application_id: Mapped[uuid.UUID] = UUIDfk("onboarding_applications.id", index=True)
    doc_type: Mapped[str] = mapped_column(sa.String(32))
    filename: Mapped[str] = mapped_column(sa.String(200))
    content_type: Mapped[str] = mapped_column(sa.String(60))
    size_bytes: Mapped[int] = mapped_column(sa.BigInteger)
    sha256: Mapped[str] = mapped_column(sa.String(64))
    storage_key: Mapped[str] = mapped_column(sa.String(200), unique=True)
    status: Mapped[DocStatus] = mapped_column(E(DocStatus), default=DocStatus.received)
    uploaded_by: Mapped[uuid.UUID] = UUIDfk("marketing_users.id")
    decided_by: Mapped[uuid.UUID | None] = UUIDfk("marketing_users.id", nullable=True)
    created_at: Mapped[datetime] = _ts()


class InvitationDelivery(Base):
    """One attempt to send an invitation through the delivery provider. Never stores the token or the message body."""
    __tablename__ = "invitation_deliveries"
    id: Mapped[uuid.UUID] = _id()
    invitation_id: Mapped[uuid.UUID] = UUIDfk("signup_invitations.id", index=True)
    channel: Mapped[str] = mapped_column(sa.String(16), default="email")
    provider: Mapped[str] = mapped_column(sa.String(32))
    provider_message_id: Mapped[str | None] = mapped_column(sa.String(120))
    status: Mapped[DeliveryStatus] = mapped_column(E(DeliveryStatus))
    error: Mapped[str | None] = mapped_column(sa.String(300))
    created_by: Mapped[uuid.UUID] = UUIDfk("marketing_users.id")
    created_at: Mapped[datetime] = _ts()
