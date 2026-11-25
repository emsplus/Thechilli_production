import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import (AfterValidator, BaseModel, BeforeValidator, ConfigDict, EmailStr, Field, field_validator,
                      model_validator)

from app.models import (ActivityType, AppSource, AppStatus, Calc, CampaignStatus, DemoStatus, EntryKind, EntryStatus,
                        LeadStage, Recipient, Role, canonical_business_types)
from app.services.normalize import normalize_email, normalize_phone


def _inr_only(v: object) -> str | None:
    """All money is INR (docs/INR_ONLY.md). Absent = INR; 'inr' is normalised; any other code is refused (422)."""
    if v is None:
        return None
    if not isinstance(v, str) or v.strip().upper() != "INR":
        raise ValueError("currency must be INR (India only)")
    return "INR"


# Kept for forward compatibility; the only accepted value is INR.
InrCurrency = Annotated[str | None, BeforeValidator(_inr_only)]


class In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---- auth / users
class LoginIn(In):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class RefreshIn(In):
    refresh_token: str = Field(min_length=1, max_length=200)


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class ChangePasswordIn(In):
    current_password: str
    new_password: str = Field(min_length=10, max_length=200)


class UserCreate(In):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=10, max_length=200)
    role: Role


class UserUpdate(In):
    name: str | None = Field(None, min_length=1, max_length=120)
    role: Role | None = None
    is_active: bool | None = None
    password: str | None = Field(None, min_length=10, max_length=200)


class UserOut(Out):
    id: uuid.UUID
    email: str
    name: str
    role: Role
    is_active: bool
    created_at: datetime


# Platform business types (enums.PLATFORM_BUSINESS_TYPES): one or more; unknown value or empty list -> 422; deduplicated and
# returned in canonical order.
BusinessType = Literal["restaurant", "cloud_kitchen", "hotel_kitchen"]
BusinessTypes = Annotated[list[BusinessType], Field(min_length=1, max_length=3), AfterValidator(canonical_business_types)]


def _default_types() -> list[str]:
    return ["restaurant"]


# ---- leads
class _Contact(In):
    @field_validator("phone", "email", check_fields=False)
    @classmethod
    def _blank_to_none(cls, v):
        return v or None


class LeadCreate(_Contact):
    business_name: str = Field(min_length=1, max_length=160)
    contact_name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(None, max_length=40)
    email: EmailStr | None = None
    city: str | None = Field(None, max_length=80)
    business_type: str | None = Field(None, max_length=40)
    source: str = Field("manual", max_length=40)
    notes: str | None = Field(None, max_length=4000)
    campaign_id: uuid.UUID | None = None
    referral_code: str | None = Field(None, max_length=32)
    owner_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _needs_contact_and_valid_phone(self):
        if not self.phone and not self.email:
            raise ValueError("a phone or an email is required")
        if self.phone:
            normalize_phone(self.phone)
        return self


class LeadUpdate(_Contact):
    business_name: str | None = Field(None, min_length=1, max_length=160)
    contact_name: str | None = Field(None, min_length=1, max_length=120)
    phone: str | None = Field(None, max_length=40)
    email: EmailStr | None = None
    city: str | None = Field(None, max_length=80)
    business_type: str | None = Field(None, max_length=40)
    source: str | None = Field(None, max_length=40)
    notes: str | None = Field(None, max_length=4000)
    campaign_id: uuid.UUID | None = None

    @field_validator("phone")
    @classmethod
    def _phone_ok(cls, v):
        if v:
            normalize_phone(v)
        return v


class LeadOut(Out):
    id: uuid.UUID
    business_name: str
    contact_name: str
    phone: str | None
    phone_norm: str | None
    email: str | None
    city: str | None
    business_type: str | None
    business_types: list[str] | None = None
    source: str
    stage: LeadStage
    lost_reason: str | None
    notes: str | None
    owner_id: uuid.UUID | None
    campaign_id: uuid.UUID | None
    referral_code_id: uuid.UUID | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class DuplicateOut(Out):
    id: uuid.UUID
    business_name: str
    stage: LeadStage
    owner_id: uuid.UUID | None


class AssignIn(In):
    owner_id: uuid.UUID | None


class StageIn(In):
    stage: LeadStage
    lost_reason: str | None = Field(None, max_length=255)


class PublicLeadIn(_Contact):
    business_name: str = Field(min_length=1, max_length=160)
    contact_name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(None, max_length=40)
    email: EmailStr | None = None
    city: str | None = Field(None, max_length=80)
    business_types: BusinessTypes = Field(default_factory=_default_types)
    referral_code: str | None = Field(None, max_length=32)

    @model_validator(mode="after")
    def _chk(self):
        if not self.phone and not self.email:
            raise ValueError("a phone or an email is required")
        if self.phone:
            normalize_phone(self.phone)
        return self


# ---- activities / demos
class ActivityCreate(In):
    type: ActivityType
    summary: str = Field(min_length=1, max_length=500)
    due_at: datetime | None = None
    assignee_id: uuid.UUID | None = None
    completed: bool = False  # log something that already happened


class ActivityOut(Out):
    id: uuid.UUID
    lead_id: uuid.UUID
    type: ActivityType
    summary: str
    due_at: datetime | None
    completed_at: datetime | None
    assignee_id: uuid.UUID | None
    created_by: uuid.UUID
    created_at: datetime


class DemoCreate(In):
    scheduled_at: datetime
    duration_minutes: int = Field(30, ge=5, le=480)
    mode: str = Field("online", pattern="^(online|on_site)$")
    location: str | None = Field(None, max_length=255)
    assignee_id: uuid.UUID | None = None


class DemoUpdate(In):
    scheduled_at: datetime | None = None
    duration_minutes: int | None = Field(None, ge=5, le=480)
    location: str | None = Field(None, max_length=255)
    status: DemoStatus | None = None
    outcome_notes: str | None = Field(None, max_length=4000)
    assignee_id: uuid.UUID | None = None


class DemoOut(Out):
    id: uuid.UUID
    lead_id: uuid.UUID
    assignee_id: uuid.UUID
    scheduled_at: datetime
    duration_minutes: int
    mode: str
    location: str | None
    status: DemoStatus
    outcome_notes: str | None
    created_at: datetime


# ---- onboarding
class AppCreate(In):
    lead_id: uuid.UUID | None = None
    business_name: str | None = Field(None, min_length=1, max_length=160)
    business_types: BusinessTypes = Field(default_factory=_default_types)  # omitted with a lead_id: derived from the lead
    owner_name: str | None = Field(None, max_length=120)
    owner_email: EmailStr | None = None
    owner_phone: str | None = Field(None, max_length=40)
    contract_value_minor: int = Field(0, ge=0, le=10**12)
    currency: InrCurrency = None
    agent_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _chk(self):
        if not self.lead_id and not self.business_name:
            raise ValueError("business_name is required without a lead_id")
        if self.owner_phone:
            normalize_phone(self.owner_phone)
        return self


class AppUpdate(In):
    business_name: str | None = Field(None, min_length=1, max_length=160)
    business_types: BusinessTypes | None = None
    owner_name: str | None = Field(None, max_length=120)
    owner_email: EmailStr | None = None
    owner_phone: str | None = Field(None, max_length=40)
    contract_value_minor: int | None = Field(None, ge=0, le=10**12)


class AppAssignIn(In):
    agent_id: uuid.UUID | None


class AppOut(Out):
    id: uuid.UUID
    lead_id: uuid.UUID | None
    agent_id: uuid.UUID | None
    source: AppSource
    status: AppStatus
    business_name: str
    business_types: list[str]
    owner_name: str | None
    owner_email: str | None
    owner_phone: str | None
    referral_code_id: uuid.UUID | None
    contract_value_minor: int
    currency: str
    external_business_id: str | None
    provisioning_error: str | None
    provisioned_at: datetime | None
    platform_status: str | None = None
    billing_status: str | None = None
    status_checked_at: datetime | None = None
    created_at: datetime


class ChecklistOut(Out):
    key: str
    status: str
    data: dict
    updated_at: datetime


# ---- invitations / referrals / campaigns
class InvitationCreate(In):
    email: EmailStr
    lead_id: uuid.UUID | None = None
    application_id: uuid.UUID | None = None
    referral_code: str | None = Field(None, max_length=32)
    ttl_hours: int | None = Field(None, ge=1, le=24 * 30)
    send: bool = False  # deliver the invite link by email through the delivery provider


class InvitationOut(Out):
    id: uuid.UUID
    email: str
    lead_id: uuid.UUID | None
    application_id: uuid.UUID | None
    referral_code_id: uuid.UUID | None
    expires_at: datetime
    used_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    delivery_status: str | None = None  # status of the latest delivery attempt: sent | failed | None (never sent)


class InvitationCreated(InvitationOut):
    token: str  # shown exactly once; only its hash is stored


class DeliveryOut(Out):
    id: uuid.UUID
    channel: str
    provider: str
    status: str
    error: str | None
    created_at: datetime


class DocumentOut(Out):
    id: uuid.UUID
    application_id: uuid.UUID
    doc_type: str
    filename: str
    content_type: str
    size_bytes: int
    status: str
    created_at: datetime


class DocumentDecision(In):
    status: Literal["verified", "rejected"]


class ActivationOut(BaseModel):
    application_id: uuid.UUID
    status: AppStatus
    external_business_id: str | None
    platform_status: str | None
    billing_status: str | None
    activated: bool  # platform-core reports the business provisioned and a trial or paid subscription is live
    paying: bool  # subscription is `active` (past the trial)
    status_checked_at: datetime | None


class LeadMergeIn(In):
    source_id: uuid.UUID  # the duplicate that is folded into the lead in the URL, then removed


class TokenIn(In):
    token: str = Field(min_length=10, max_length=200)


class RedeemIn(TokenIn):
    owner_name: str = Field(min_length=1, max_length=120)
    business_name: str = Field(min_length=1, max_length=160)
    business_types: BusinessTypes = Field(default_factory=_default_types)  # an existing (agent-created) application keeps its own unless sent
    owner_phone: str | None = Field(None, max_length=40)


class ReferralCreate(In):
    code: str | None = Field(None, pattern=r"^[A-Za-z0-9]{4,32}$")
    owner_id: uuid.UUID | None = None
    campaign_id: uuid.UUID | None = None
    max_uses: int | None = Field(None, ge=1)
    expires_at: datetime | None = None


class ReferralUpdate(In):
    is_active: bool | None = None
    max_uses: int | None = Field(None, ge=1)
    expires_at: datetime | None = None


class ReferralOut(Out):
    id: uuid.UUID
    code: str
    owner_id: uuid.UUID
    campaign_id: uuid.UUID | None
    is_active: bool
    max_uses: int | None
    expires_at: datetime | None
    created_at: datetime
    uses: int = 0


class AttributionOut(Out):
    id: uuid.UUID
    referral_code_id: uuid.UUID
    lead_id: uuid.UUID | None
    application_id: uuid.UUID | None
    created_at: datetime


class CampaignCreate(In):
    name: str = Field(min_length=1, max_length=120)
    channel: str = Field(min_length=1, max_length=40)
    status: CampaignStatus = CampaignStatus.draft
    budget_minor: int = Field(0, ge=0, le=10**12)
    currency: InrCurrency = None
    starts_on: date | None = None
    ends_on: date | None = None

    @model_validator(mode="after")
    def _dates(self):
        if self.starts_on and self.ends_on and self.ends_on < self.starts_on:
            raise ValueError("ends_on is before starts_on")
        return self


class CampaignUpdate(In):
    name: str | None = Field(None, min_length=1, max_length=120)
    channel: str | None = Field(None, min_length=1, max_length=40)
    status: CampaignStatus | None = None
    budget_minor: int | None = Field(None, ge=0, le=10**12)
    starts_on: date | None = None
    ends_on: date | None = None


class CampaignOut(Out):
    id: uuid.UUID
    name: str
    channel: str
    status: CampaignStatus
    budget_minor: int
    currency: str
    starts_on: date | None
    ends_on: date | None
    created_at: datetime


# ---- commissions
class RuleCreate(In):
    name: str = Field(min_length=1, max_length=120)
    recipient: Recipient
    calc: Calc
    flat_amount_minor: int = Field(0, ge=0, le=10**12)
    rate_bps: int = Field(0, ge=0, le=10000)
    cap_minor: int | None = Field(None, ge=0, le=10**12)
    min_base_minor: int = Field(0, ge=0, le=10**12)
    currency: InrCurrency = None
    valid_from: date | None = None
    valid_to: date | None = None

    @model_validator(mode="after")
    def _chk(self):
        if self.calc == Calc.flat and (self.flat_amount_minor <= 0 or self.rate_bps):
            raise ValueError("flat rules need flat_amount_minor > 0 and no rate_bps")
        if self.calc == Calc.percent_bps and (self.rate_bps <= 0 or self.flat_amount_minor):
            raise ValueError("percent_bps rules need rate_bps > 0 and no flat_amount_minor")
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("valid_to is before valid_from")
        return self


class RuleUpdate(In):
    is_active: bool | None = None
    valid_to: date | None = None
    cap_minor: int | None = Field(None, ge=0, le=10**12)


class RuleOut(Out):
    id: uuid.UUID
    name: str
    recipient: Recipient
    calc: Calc
    flat_amount_minor: int
    rate_bps: int
    cap_minor: int | None
    min_base_minor: int
    currency: str
    is_active: bool
    valid_from: date | None
    valid_to: date | None


class EntryOut(Out):
    id: uuid.UUID
    kind: EntryKind
    rule_id: uuid.UUID | None
    user_id: uuid.UUID
    application_id: uuid.UUID | None
    lead_id: uuid.UUID | None
    base_amount_minor: int
    amount_minor: int
    currency: str
    status: EntryStatus
    reverses_entry_id: uuid.UUID | None
    decided_by: uuid.UUID | None
    decided_at: datetime | None
    note: str | None
    created_at: datetime


class DecisionIn(In):
    note: str | None = Field(None, max_length=255)


class AuditOut(Out):
    id: uuid.UUID
    actor_id: uuid.UUID | None
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    meta: dict | None
    created_at: datetime
