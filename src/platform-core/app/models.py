"""All tables. Platform-level data only: NO tenant operational data (orders, menus, customers, staff, sales) lives here."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Identity, Index, Integer, Sequence,
                        String, Text, UniqueConstraint, text)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def pk():
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def ts(**kw):
    return mapped_column(DateTime(timezone=True), default=utcnow, **kw)


def fk(target, **kw):
    return mapped_column(UUID(as_uuid=True), ForeignKey(target), **kw)


# What the tenant operates as: ONE OR MORE of these (e.g. restaurant + cloud_kitchen; a hotel with an in-house restaurant =
# restaurant + hotel_kitchen). restaurant also covers cafes; a hotel kitchen is set up like a cloud kitchen (no dine-in).
# Stored as a JSONB array, deduplicated, in this canonical order. pos-service derives capabilities from it; here it only sets
# entitlement defaults (app/services/entitlements.py).
BUSINESS_TYPES = ("restaurant", "cloud_kitchen", "hotel_kitchen")
DEFAULT_BUSINESS_TYPES = ["restaurant"]
BUSINESS_TYPES_CHECK = ("case when jsonb_typeof(business_types) = 'array' then jsonb_array_length(business_types) >= 1 "
                        "and business_types <@ '[\"restaurant\",\"cloud_kitchen\",\"hotel_kitchen\"]'::jsonb else false end")


def canonical_business_types(values) -> list[str]:
    """Distinct values in canonical order. Unknown values raise ValueError; an empty selection is an error too."""
    vals = set(values or ())
    unknown = vals - set(BUSINESS_TYPES)
    if unknown:
        raise ValueError(f"unknown business type(s): {', '.join(sorted(map(str, unknown)))}")
    if not vals:
        raise ValueError("select at least one business type")
    return [t for t in BUSINESS_TYPES if t in vals]


# ---------------- staff ----------------
class StaffUser(Base):
    __tablename__ = "staff_users"
    id: Mapped[uuid.UUID] = pk()
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts()
    __table_args__ = (CheckConstraint("role in ('super_admin','platform_admin','support','finance')", name="ck_staff_role"),)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[uuid.UUID] = pk()
    staff_id: Mapped[uuid.UUID] = fk("staff_users.id", index=True)
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts()
    ip: Mapped[str | None] = mapped_column(String(64))  # session metadata, carried across rotation (family = session)
    user_agent: Mapped[str | None] = mapped_column(String(300))
    mfa: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))


class StaffMfa(Base):
    """TOTP enrolment. The secret is stored encrypted (Fernet, MFA_ENCRYPTION_KEY); `confirmed_at` null = enrolment pending."""
    __tablename__ = "staff_mfa"
    staff_id: Mapped[uuid.UUID] = fk("staff_users.id", primary_key=True)
    secret_enc: Mapped[str] = mapped_column(Text)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_step: Mapped[int | None] = mapped_column(BigInteger)  # last accepted TOTP time step (replay protection)
    created_at: Mapped[datetime] = ts()


class MfaRecoveryCode(Base):
    __tablename__ = "mfa_recovery_codes"
    id: Mapped[uuid.UUID] = pk()
    staff_id: Mapped[uuid.UUID] = fk("staff_users.id", index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts()


class StepUpGrant(Base):
    """A fresh second-factor proof for sensitive actions (docs/STEP_UP.md). Bound to one staff member and one session
    (refresh-token family); only the sha256 of the opaque token is stored. `uses_left` reaches 0 = spent."""
    __tablename__ = "step_up_grants"
    id: Mapped[uuid.UUID] = pk()
    staff_id: Mapped[uuid.UUID] = fk("staff_users.id", index=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    method: Mapped[str] = mapped_column(String(16))  # totp | recovery_code
    uses_left: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = ts()


class MfaAttempt(Base):
    __tablename__ = "mfa_attempts"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    staff_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    ip: Mapped[str] = mapped_column(String(64))
    success: Mapped[bool] = mapped_column(Boolean)
    at: Mapped[datetime] = ts(index=True)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    ip: Mapped[str] = mapped_column(String(64), index=True)
    success: Mapped[bool] = mapped_column(Boolean)
    at: Mapped[datetime] = ts(index=True)


class ServiceClient(Base):
    """Machine credentials for other Chilli services (pos-service, marketing-service). Key shown once, only sha256 stored."""
    __tablename__ = "service_clients"
    id: Mapped[uuid.UUID] = pk()
    name: Mapped[str] = mapped_column(String(100), unique=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    scopes: Mapped[list] = mapped_column(JSONB, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = ts()
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------------- tenants ----------------
class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[uuid.UUID] = pk()
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    display_name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), default="pending")
    status_reason: Mapped[str | None] = mapped_column(Text)
    pos_tenant_ref: Mapped[str | None] = mapped_column(String(100))  # id in pos-service, set by provisioning
    business_types: Mapped[list] = mapped_column(JSONB, default=lambda: list(DEFAULT_BUSINESS_TYPES),
                                                 server_default=text("'[\"restaurant\"]'::jsonb"))
    created_at: Mapped[datetime] = ts()
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("status in ('pending','active','suspended','closed')", name="ck_tenant_status"),
                      CheckConstraint(BUSINESS_TYPES_CHECK, name="ck_tenant_business_types"))


class BusinessProfile(Base):
    __tablename__ = "business_profiles"
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", primary_key=True)
    legal_name: Mapped[str] = mapped_column(String(300))
    gstin: Mapped[str | None] = mapped_column(String(15))
    pan: Mapped[str | None] = mapped_column(String(10))
    fssai: Mapped[str | None] = mapped_column(String(14))
    state_code: Mapped[str | None] = mapped_column(String(2))
    address: Mapped[str | None] = mapped_column(Text)
    city: Mapped[str | None] = mapped_column(String(100))
    pincode: Mapped[str | None] = mapped_column(String(6))
    contact_name: Mapped[str | None] = mapped_column(String(200))
    contact_email: Mapped[str | None] = mapped_column(String(320))
    contact_phone: Mapped[str | None] = mapped_column(String(20))
    updated_at: Mapped[datetime] = ts()


class Outlet(Base):
    """Registry entry only (name/location/status). Operational outlet data lives in pos-service."""
    __tablename__ = "outlets"
    id: Mapped[uuid.UUID] = pk()
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", index=True)
    name: Mapped[str] = mapped_column(String(200))
    code: Mapped[str | None] = mapped_column(String(32))
    city: Mapped[str | None] = mapped_column(String(100))
    state_code: Mapped[str | None] = mapped_column(String(2))
    status: Mapped[str] = mapped_column(String(16), default="active")
    pos_outlet_ref: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = ts()
    __table_args__ = (UniqueConstraint("tenant_id", "code", name="uq_outlet_code"),
                      CheckConstraint("status in ('active','inactive')", name="ck_outlet_status"))


# ---------------- onboarding ----------------
class OnboardingApplication(Base):
    __tablename__ = "onboarding_applications"
    id: Mapped[uuid.UUID] = pk()
    source: Mapped[str] = mapped_column(String(24))  # self_signup | marketing | staff
    idempotency_key: Mapped[str | None] = mapped_column(String(100), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="received")
    business_name: Mapped[str] = mapped_column(String(200))
    contact_name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), index=True)
    phone: Mapped[str | None] = mapped_column(String(20))
    plan_code: Mapped[str | None] = mapped_column(String(64))
    business_types: Mapped[list] = mapped_column(JSONB, default=lambda: list(DEFAULT_BUSINESS_TYPES),
                                                 server_default=text("'[\"restaurant\"]'::jsonb"))  # copied to the tenant
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    marketing_ref: Mapped[str | None] = mapped_column(String(100))
    submitter_ip: Mapped[str | None] = mapped_column(String(64), index=True)
    tenant_id: Mapped[uuid.UUID | None] = fk("tenants.id")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    reject_reason: Mapped[str | None] = mapped_column(Text)
    # Provisioning workflow (app/services/onboarding.py): queued -> provisioning -> owner_invited -> live, or failed (retry with
    # backoff until provision_max_attempts, then manual). NULL until the application is approved.
    provision_state: Mapped[str | None] = mapped_column(String(16))
    provision_next_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # next automatic attempt; NULL = none scheduled
    provision_error_code: Mapped[str | None] = mapped_column(String(48))
    owner_invited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    live_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invite_sends: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = ts()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (
        CheckConstraint("status in ('received','under_review','approved','provisioning','provisioned','failed','rejected')", name="ck_app_status"),
        CheckConstraint("provision_state is null or provision_state in ('queued','provisioning','owner_invited','live','failed')", name="ck_app_provision_state"),
        CheckConstraint(BUSINESS_TYPES_CHECK, name="ck_app_business_types"),
        Index("ix_app_provision_due", "provision_state", "provision_next_at"),
    )


class OnboardingEvent(Base):
    __tablename__ = "onboarding_events"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    application_id: Mapped[uuid.UUID] = fk("onboarding_applications.id", index=True)
    from_status: Mapped[str | None] = mapped_column(String(16))
    to_status: Mapped[str] = mapped_column(String(16))
    actor: Mapped[str] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(Text)
    at: Mapped[datetime] = ts()


# ---------------- catalog / plans / subscriptions ----------------
class Feature(Base):
    __tablename__ = "features"
    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(8), default="flag")  # flag | limit
    unit: Mapped[str | None] = mapped_column(String(32))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    __table_args__ = (CheckConstraint("kind in ('flag','limit')", name="ck_feature_kind"),)


class Plan(Base):
    __tablename__ = "plans"
    id: Mapped[uuid.UUID] = pk()
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    price_paise: Mapped[int] = mapped_column(BigInteger, default=0)  # excl. GST
    billing_period: Mapped[str] = mapped_column(String(8), default="month")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = ts()
    version: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("price_paise >= 0", name="ck_plan_price"),
                      CheckConstraint("billing_period in ('month','year')", name="ck_plan_period"))


class PlanVersion(Base):
    """Append-only snapshot of a plan after every create/edit/retire (version n = state after the n-th change)."""
    __tablename__ = "plan_versions"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    plan_id: Mapped[uuid.UUID] = fk("plans.id", index=True)
    version: Mapped[int] = mapped_column(Integer)
    snapshot: Mapped[dict] = mapped_column(JSONB)
    change: Mapped[str] = mapped_column(String(24))  # created | edited | retired | reactivated
    note: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(String(100))
    at: Mapped[datetime] = ts()
    __table_args__ = (UniqueConstraint("plan_id", "version", name="uq_plan_version"),)


class PlanFeature(Base):
    __tablename__ = "plan_features"
    plan_id: Mapped[uuid.UUID] = fk("plans.id", primary_key=True)
    feature_code: Mapped[str] = mapped_column(ForeignKey("features.code"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    limit_value: Mapped[int | None] = mapped_column(Integer)  # null = unlimited (for kind=limit)


class Subscription(Base):
    __tablename__ = "subscriptions"
    id: Mapped[uuid.UUID] = pk()
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", index=True)
    plan_id: Mapped[uuid.UUID] = fk("plans.id")
    status: Mapped[str] = mapped_column(String(12), default="active")
    trial_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    current_period_start: Mapped[datetime] = ts()
    current_period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts()
    __table_args__ = (
        CheckConstraint("status in ('trialing','active','past_due','cancelled','expired')", name="ck_sub_status"),
        # at most one live subscription per tenant
        Index("uq_sub_live", "tenant_id", unique=True, postgresql_where=text("status in ('trialing','active','past_due')")),
    )


class EntitlementOverride(Base):
    __tablename__ = "entitlement_overrides"
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", primary_key=True)
    feature_code: Mapped[str] = mapped_column(ForeignKey("features.code"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean)
    limit_value: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = ts()


class EntitlementHistory(Base):
    """Append-only. One row per feature whose effective entitlement changed."""
    __tablename__ = "entitlement_history"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    feature_code: Mapped[str] = mapped_column(String(64))
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    trigger: Mapped[str] = mapped_column(String(48))
    actor: Mapped[str] = mapped_column(String(100))
    reason: Mapped[str | None] = mapped_column(Text)
    at: Mapped[datetime] = ts(index=True)


# ---------------- billing ----------------
invoice_seq = Sequence("invoice_number_seq", start=1)


class Invoice(Base):
    __tablename__ = "invoices"
    id: Mapped[uuid.UUID] = pk()
    number: Mapped[str | None] = mapped_column(String(40), unique=True)  # assigned on issue
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", index=True)
    subscription_id: Mapped[uuid.UUID | None] = fk("subscriptions.id")
    status: Mapped[str] = mapped_column(String(8), default="draft")
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    subtotal_paise: Mapped[int] = mapped_column(BigInteger)
    discount_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    taxable_paise: Mapped[int] = mapped_column(BigInteger)
    gst_rate_bps: Mapped[int] = mapped_column(Integer)  # copied from config at creation
    cgst_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    sgst_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    igst_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    total_paise: Mapped[int] = mapped_column(BigInteger)
    supplier_gstin: Mapped[str | None] = mapped_column(String(15))
    supplier_state_code: Mapped[str] = mapped_column(String(2))
    buyer_gstin: Mapped[str | None] = mapped_column(String(15))
    buyer_state_code: Mapped[str | None] = mapped_column(String(2))
    sac_code: Mapped[str] = mapped_column(String(8))
    tax_needs_ca_verification: Mapped[bool] = mapped_column(Boolean, default=True)
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    void_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts()
    __table_args__ = (
        CheckConstraint("status in ('draft','issued','paid','void')", name="ck_inv_status"),
        CheckConstraint("subtotal_paise >= 0 and discount_paise >= 0 and taxable_paise >= 0 and total_paise >= 0", name="ck_inv_nonneg"),
        CheckConstraint("taxable_paise = subtotal_paise - discount_paise", name="ck_inv_taxable"),
        CheckConstraint("total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise", name="ck_inv_total"),
    )


class InvoiceLine(Base):
    __tablename__ = "invoice_lines"
    id: Mapped[uuid.UUID] = pk()
    invoice_id: Mapped[uuid.UUID] = fk("invoices.id", index=True)
    description: Mapped[str] = mapped_column(String(300))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price_paise: Mapped[int] = mapped_column(BigInteger)
    amount_paise: Mapped[int] = mapped_column(BigInteger)


class PaymentTransaction(Base):
    __tablename__ = "payment_transactions"
    id: Mapped[uuid.UUID] = pk()
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", index=True)
    invoice_id: Mapped[uuid.UUID | None] = fk("invoices.id", index=True)
    provider: Mapped[str] = mapped_column(String(32))  # free text: razorpay, cashfree, bank_transfer, ...
    provider_ref: Mapped[str] = mapped_column(String(100))
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    method: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(12), default="initiated")
    raw: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = ts()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (UniqueConstraint("provider", "provider_ref", name="uq_payment_provider_ref"),
                      CheckConstraint("amount_paise > 0", name="ck_pay_amount"),
                      CheckConstraint("status in ('initiated','succeeded','failed','refunded')", name="ck_pay_status"))


# ---------------- pay-as-you-go wallet (docs/PAYG_BILLING.md) ----------------
class BillingSettings(Base):
    """Per-plan or per-tenant overrides of the PAYG defaults (config PAYG_*). Exactly one of plan_id / tenant_id is set.
    NULL in a field = inherit (tenant -> plan -> default)."""
    __tablename__ = "billing_settings"
    id: Mapped[uuid.UUID] = pk()
    plan_id: Mapped[uuid.UUID | None] = fk("plans.id", unique=True)
    tenant_id: Mapped[uuid.UUID | None] = fk("tenants.id", unique=True)
    billing_model: Mapped[str | None] = mapped_column(String(12))  # payg | subscription
    trial_days: Mapped[int | None] = mapped_column(Integer)
    per_bill_paise: Mapped[int | None] = mapped_column(Integer)
    fee_gst_mode: Mapped[str | None] = mapped_column(String(10))  # inclusive | exclusive
    charge_zero_bills: Mapped[bool | None] = mapped_column(Boolean)
    low_balance_paise: Mapped[int | None] = mapped_column(BigInteger)
    grace_paise: Mapped[int | None] = mapped_column(BigInteger)
    min_topup_paise: Mapped[int | None] = mapped_column(BigInteger)
    bonus_tiers: Mapped[list | None] = mapped_column(JSONB)  # [{"min_paise": 50000, "bonus_paise": 2500}, ...]
    updated_by: Mapped[str | None] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (
        CheckConstraint("(plan_id is null) <> (tenant_id is null)", name="ck_bset_scope"),
        CheckConstraint("billing_model is null or billing_model in ('payg','subscription')", name="ck_bset_model"),
        CheckConstraint("fee_gst_mode is null or fee_gst_mode in ('inclusive','exclusive')", name="ck_bset_gst"),
        CheckConstraint("trial_days is null or trial_days between 0 and 365", name="ck_bset_trial"),
        CheckConstraint("(per_bill_paise is null or per_bill_paise >= 0) and (low_balance_paise is null or low_balance_paise >= 0)"
                        " and (grace_paise is null or grace_paise >= 0) and (min_topup_paise is null or min_topup_paise >= 0)",
                        name="ck_bset_nonneg"),
    )


class Wallet(Base):
    """Prepaid credit of one tenant, integer paise. `balance_paise` always equals the balance_after of the tenant's latest
    wallet_ledger row (tests/test_wallet.py). Every change locks this row (SELECT ... FOR UPDATE) first."""
    __tablename__ = "wallets"
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", primary_key=True)
    balance_paise: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    trial_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    trial_ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    suspended_reason: Mapped[str | None] = mapped_column(Text)
    last_state: Mapped[str | None] = mapped_column(String(12))  # last computed state, for transition notices
    created_at: Mapped[datetime] = ts()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


LEDGER_KINDS = ("topup", "bill_fee", "void_credit_back", "adjustment", "promo")


class WalletLedger(Base):
    """Append-only money movements. `idem_key` makes every movement happen at most once per tenant:
    bill_fee:<bill id>, void:<bill id>, adm:<Idempotency-Key>, rzp:<payment id>, bonus:<receipt id>."""
    __tablename__ = "wallet_ledger"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    amount_paise: Mapped[int] = mapped_column(BigInteger)  # signed: + credit, - debit
    balance_after_paise: Mapped[int] = mapped_column(BigInteger)
    idem_key: Mapped[str] = mapped_column(String(120))
    source: Mapped[str] = mapped_column(String(16))  # pos | admin | promo | razorpay | system
    ref_type: Mapped[str | None] = mapped_column(String(24))
    ref_id: Mapped[str | None] = mapped_column(String(64))
    fee_base_paise: Mapped[int | None] = mapped_column(BigInteger)  # bill_fee / void_credit_back: fee excl. GST
    fee_gst_paise: Mapped[int | None] = mapped_column(BigInteger)
    reason: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(String(100))
    meta: Mapped[dict | None] = mapped_column(JSONB)
    at: Mapped[datetime] = ts(index=True)
    __table_args__ = (
        UniqueConstraint("tenant_id", "idem_key", name="uq_wallet_ledger_idem"),
        CheckConstraint("kind in ('topup','bill_fee','void_credit_back','adjustment','promo')", name="ck_wl_kind"),
        CheckConstraint("amount_paise <> 0", name="ck_wl_nonzero"),
        CheckConstraint("(kind = 'bill_fee' and amount_paise < 0) or (kind in ('topup','promo','void_credit_back') and amount_paise > 0)"
                        " or kind = 'adjustment'", name="ck_wl_sign"),
        Index("ix_wallet_ledger_tenant_at", "tenant_id", "at", "id"),
    )


class UsageEvent(Base):
    """Append-only metering record: one row per (tenant, bill, event) reported by pos-service, charged or not (trial, zero
    total, ...). The bill id is the ROOT bill of an amendment chain, so a corrected bill is never charged twice."""
    __tablename__ = "billing_usage_events"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    bill_id: Mapped[str] = mapped_column(String(64))
    event: Mapped[str] = mapped_column(String(10))  # finalized | voided
    outlet_id: Mapped[str | None] = mapped_column(String(64))
    invoice_number: Mapped[str | None] = mapped_column(String(40))
    bill_total_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    offline: Mapped[bool] = mapped_column(Boolean, default=False)
    outcome: Mapped[str] = mapped_column(String(24))
    charged_paise: Mapped[int] = mapped_column(BigInteger, default=0)  # debited (finalized) or credited back (voided), >= 0
    ledger_id: Mapped[int | None] = mapped_column(BigInteger)
    source: Mapped[str] = mapped_column(String(48))
    received_at: Mapped[datetime] = ts(index=True)
    __table_args__ = (
        UniqueConstraint("tenant_id", "bill_id", "event", name="uq_usage_bill_event"),
        CheckConstraint("event in ('finalized','voided')", name="ck_usage_event"),
        CheckConstraint("charged_paise >= 0", name="ck_usage_charged"),
        Index("ix_usage_tenant_occurred", "tenant_id", "occurred_at"),
    )


receipt_seq = Sequence("wallet_receipt_seq", start=1)


class WalletReceipt(Base):
    """Numbered receipt for money received into a wallet (admin-recorded payment or Razorpay). GST fields are placeholders
    computed from configuration and flagged for CA verification."""
    __tablename__ = "wallet_receipts"
    id: Mapped[uuid.UUID] = pk()
    number: Mapped[str] = mapped_column(String(40), unique=True)
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", index=True)
    source: Mapped[str] = mapped_column(String(16))  # admin | razorpay
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    bonus_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    gst_mode: Mapped[str] = mapped_column(String(10))
    taxable_paise: Mapped[int] = mapped_column(BigInteger)
    gst_rate_bps: Mapped[int] = mapped_column(Integer)
    cgst_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    sgst_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    igst_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    sac_code: Mapped[str] = mapped_column(String(8))
    supplier_gstin: Mapped[str | None] = mapped_column(String(15))
    supplier_state_code: Mapped[str] = mapped_column(String(2))
    buyer_gstin: Mapped[str | None] = mapped_column(String(15))
    buyer_state_code: Mapped[str | None] = mapped_column(String(2))
    tax_needs_ca_verification: Mapped[bool] = mapped_column(Boolean, default=True)
    payment_ref: Mapped[str | None] = mapped_column(String(100))
    ledger_id: Mapped[int] = mapped_column(BigInteger)
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = ts()
    __table_args__ = (CheckConstraint("amount_paise > 0 and bonus_paise >= 0", name="ck_receipt_amount"),)


class TopupOrder(Base):
    """Online top-up attempt (Razorpay, behind TOPUP_ONLINE_ENABLED). Created by POST /billing/topups/intent; credited once by
    the webhook (unique provider_payment_id). No provider call is made by platform-core yet (payments-service later)."""
    __tablename__ = "wallet_topup_orders"
    id: Mapped[uuid.UUID] = pk()
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", index=True)
    provider: Mapped[str] = mapped_column(String(16), default="razorpay")
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    bonus_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(12), default="created")
    provider_order_id: Mapped[str | None] = mapped_column(String(100), unique=True)
    provider_payment_id: Mapped[str | None] = mapped_column(String(100), unique=True)
    receipt_id: Mapped[uuid.UUID | None] = fk("wallet_receipts.id")
    requested_by: Mapped[str] = mapped_column(String(100))
    raw: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = ts()
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_link_id: Mapped[str | None] = mapped_column(String(100), unique=True)  # Razorpay payment link id (plink_...)
    short_url: Mapped[str | None] = mapped_column(String(300))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("amount_paise > 0", name="ck_topup_amount"),
                      CheckConstraint("status in ('created','paid','failed','expired')", name="ck_topup_status"),
                      Index("ix_wallet_topup_orders_tenant_created", "tenant_id", "created_at"))


class RazorpayEvent(Base):
    """Every Razorpay webhook that passed signature verification, once per event id (X-Razorpay-Event-Id, else a hash of the body).
    The unique event_id is the first replay guard; the credit itself is guarded again by the ledger's unique idem key."""
    __tablename__ = "razorpay_events"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    event_id: Mapped[str] = mapped_column(String(120), unique=True)
    event: Mapped[str] = mapped_column(String(40))
    payment_id: Mapped[str | None] = mapped_column(String(100), index=True)
    topup_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    amount_paise: Mapped[int | None] = mapped_column(BigInteger)
    outcome: Mapped[str] = mapped_column(String(32))  # credited | duplicate_payment | amount_mismatch | unknown_intent | not_captured | ignored
    received_at: Mapped[datetime] = ts()


class BillingOutbox(Base):
    """Transactional outbox of billing events (event_type `billing.notice`): trial ending / ended, low credit, credit
    exhausted, top-up received. Written in the same transaction as the change; consumed by the mail module through
    POST /billing/outbox/claim + /ack (service scope billing.outbox). `dedupe_key` makes each notice exist once."""
    __tablename__ = "billing_outbox"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    event_type: Mapped[str] = mapped_column(String(32), default="billing.notice")
    kind: Mapped[str] = mapped_column(String(32))
    dedupe_key: Mapped[str] = mapped_column(String(120))
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(8), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts()
    __table_args__ = (UniqueConstraint("tenant_id", "dedupe_key", name="uq_billing_outbox_dedupe"),
                      CheckConstraint("status in ('pending','sent','dead')", name="ck_billing_outbox_status"),
                      Index("ix_billing_outbox_pending", "status", "created_at"))


# ---------------- support ----------------
class SupportTicket(Base):
    __tablename__ = "support_tickets"
    id: Mapped[uuid.UUID] = pk()
    tenant_id: Mapped[uuid.UUID | None] = fk("tenants.id", index=True)
    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    priority: Mapped[str] = mapped_column(String(8), default="normal")
    status: Mapped[str] = mapped_column(String(12), default="open")
    requester_email: Mapped[str | None] = mapped_column(String(320))
    assignee_id: Mapped[uuid.UUID | None] = fk("staff_users.id")
    created_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = ts()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (
        CheckConstraint("status in ('open','in_progress','waiting','resolved','closed')", name="ck_ticket_status"),
        CheckConstraint("priority in ('low','normal','high','urgent')", name="ck_ticket_priority"))


class TicketComment(Base):
    __tablename__ = "ticket_comments"
    id: Mapped[uuid.UUID] = pk()
    ticket_id: Mapped[uuid.UUID] = fk("support_tickets.id", index=True)
    author: Mapped[str] = mapped_column(String(100))
    body: Mapped[str] = mapped_column(Text)
    internal: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = ts()


class SupportAccessGrant(Base):
    __tablename__ = "support_access_grants"
    id: Mapped[uuid.UUID] = pk()
    tenant_id: Mapped[uuid.UUID] = fk("tenants.id", index=True)
    staff_id: Mapped[uuid.UUID] = fk("staff_users.id", index=True)  # grantee
    ticket_id: Mapped[uuid.UUID | None] = fk("support_tickets.id")
    scope: Mapped[str] = mapped_column(String(24), default="read_only")
    reason: Mapped[str] = mapped_column(Text)
    granted_by: Mapped[uuid.UUID] = fk("staff_users.id")
    starts_at: Mapped[datetime] = ts()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[uuid.UUID | None] = fk("staff_users.id")
    created_at: Mapped[datetime] = ts()
    __table_args__ = (CheckConstraint("scope in ('read_only','diagnostics')", name="ck_grant_scope"),
                      CheckConstraint("expires_at > starts_at", name="ck_grant_window"))


# ---------------- append-only logs ----------------
class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    at: Mapped[datetime] = ts(index=True)
    actor_type: Mapped[str] = mapped_column(String(10))  # staff | service | system | anonymous
    actor_id: Mapped[str | None] = mapped_column(String(64))
    actor_label: Mapped[str | None] = mapped_column(String(320))
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str | None] = mapped_column(String(48))
    target_id: Mapped[str | None] = mapped_column(String(64))
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    ip: Mapped[str | None] = mapped_column(String(64))
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    meta: Mapped[dict | None] = mapped_column(JSONB)


class SecurityEvent(Base):
    __tablename__ = "security_events"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    at: Mapped[datetime] = ts(index=True)
    type: Mapped[str] = mapped_column(String(48), index=True)
    severity: Mapped[str] = mapped_column(String(8), default="info")
    staff_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    email: Mapped[str | None] = mapped_column(String(320))
    ip: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict | None] = mapped_column(JSONB)


class AiUsageRecord(Base):
    __tablename__ = "ai_usage_records"
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    at: Mapped[datetime] = ts(index=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    source_service: Mapped[str] = mapped_column(String(48))
    external_id: Mapped[str] = mapped_column(String(100))  # idempotency key from the reporting service
    feature: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(64))
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cost_micro_inr: Mapped[int] = mapped_column(BigInteger, default=0)  # millionths of a rupee
    __table_args__ = (UniqueConstraint("source_service", "external_id", name="uq_ai_usage_ext"),
                      CheckConstraint("input_tokens >= 0 and output_tokens >= 0 and cost_micro_inr >= 0", name="ck_ai_nonneg"))


# ---------------- system ----------------
class JobHeartbeat(Base):
    __tablename__ = "job_heartbeats"
    job_name: Mapped[str] = mapped_column(String(100), primary_key=True)
    service: Mapped[str] = mapped_column(String(48), primary_key=True)
    status: Mapped[str] = mapped_column(String(8), default="ok")
    last_seen_at: Mapped[datetime] = ts()
    last_duration_ms: Mapped[int | None] = mapped_column(Integer)
    expected_interval_seconds: Mapped[int] = mapped_column(Integer, default=300)
    details: Mapped[dict | None] = mapped_column(JSONB)


class GlobalConfig(Base):
    __tablename__ = "global_config"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict | list | str | int | float | bool | None] = mapped_column(JSONB)
    description: Mapped[str | None] = mapped_column(Text)
    updated_by: Mapped[str | None] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


APPEND_ONLY_TABLES = ["audit_log", "security_events", "ai_usage_records", "entitlement_history", "onboarding_events",
                      "wallet_ledger", "billing_usage_events"]
