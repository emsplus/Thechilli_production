import enum


class Role(str, enum.Enum):
    marketing_admin = "marketing_admin"
    salesperson = "salesperson"
    onboarding_agent = "onboarding_agent"


class LeadStage(str, enum.Enum):
    new = "new"
    contacted = "contacted"
    qualified = "qualified"
    demo_scheduled = "demo_scheduled"
    demo_done = "demo_done"
    negotiation = "negotiation"
    won = "won"
    lost = "lost"


# Allowed forward moves. Stages can also step back one position in the funnel (see services/leads.py);
# `won` is terminal and is only reached through provisioning; `lost` can be re-opened to `new`.
STAGE_ORDER = [LeadStage.new, LeadStage.contacted, LeadStage.qualified, LeadStage.demo_scheduled,
               LeadStage.demo_done, LeadStage.negotiation]


class ActivityType(str, enum.Enum):
    call = "call"
    whatsapp = "whatsapp"
    email = "email"
    visit = "visit"
    note = "note"
    follow_up = "follow_up"


class DemoStatus(str, enum.Enum):
    scheduled = "scheduled"
    completed = "completed"
    cancelled = "cancelled"
    no_show = "no_show"


class AppStatus(str, enum.Enum):
    draft = "draft"
    in_progress = "in_progress"
    ready = "ready"
    provisioned = "provisioned"
    cancelled = "cancelled"


class AppSource(str, enum.Enum):
    assisted = "assisted"
    self_signup = "self_signup"


class ChecklistKey(str, enum.Enum):
    business_type = "business_type"
    outlet = "outlet"
    menu = "menu"
    staff = "staff"
    documents = "documents"


class ChecklistStatus(str, enum.Enum):
    pending = "pending"
    in_progress = "in_progress"
    done = "done"


class CampaignStatus(str, enum.Enum):
    draft = "draft"
    active = "active"
    paused = "paused"
    ended = "ended"


class Recipient(str, enum.Enum):
    lead_owner = "lead_owner"
    application_agent = "application_agent"
    referrer = "referrer"


class Calc(str, enum.Enum):
    flat = "flat"
    percent_bps = "percent_bps"


class EntryKind(str, enum.Enum):
    commission = "commission"
    reversal = "reversal"


class EntryStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    paid = "paid"


class DocStatus(str, enum.Enum):
    received = "received"
    verified = "verified"
    rejected = "rejected"


class DeliveryStatus(str, enum.Enum):
    sent = "sent"
    failed = "failed"


# Platform business types (shared contract with platform-core and pos-service): a business selects ONE OR MORE of
# restaurant (also cafes) | cloud_kitchen | hotel_kitchen (set up like a cloud kitchen). Stored on onboarding applications as a
# deduplicated JSON array in this canonical order and forwarded to platform-core as `business_types`.
PLATFORM_BUSINESS_TYPES = ("restaurant", "cloud_kitchen", "hotel_kitchen")
DEFAULT_BUSINESS_TYPES = ["restaurant"]
BUSINESS_TYPES_CHECK = ("case when jsonb_typeof(business_types) = 'array' then jsonb_array_length(business_types) >= 1 "
                        "and business_types <@ '[\"restaurant\",\"cloud_kitchen\",\"hotel_kitchen\"]'::jsonb else false end")


def canonical_business_types(values) -> list[str]:
    """Distinct values in canonical order; unknown values or an empty selection raise ValueError."""
    vals = set(values or ())
    unknown = vals - set(PLATFORM_BUSINESS_TYPES)
    if unknown:
        raise ValueError(f"unknown business type(s): {', '.join(sorted(map(str, unknown)))}")
    if not vals:
        raise ValueError("select at least one business type")
    return [t for t in PLATFORM_BUSINESS_TYPES if t in vals]


def platform_business_type(kind: str | None) -> str:
    """Map a descriptive kind (lead.business_type, the checklist `business_type` item: restaurant, cafe, bakery, cloud_kitchen,
    food_truck, bar, other, hotel_kitchen) onto the platform type. Anything that is not a cloud/hotel kitchen is a restaurant."""
    return kind if kind in PLATFORM_BUSINESS_TYPES else "restaurant"


def platform_business_types(kinds) -> list[str]:
    """Map descriptive kinds onto the platform selection (union, canonical order); no kinds -> ["restaurant"]."""
    return canonical_business_types({platform_business_type(k) for k in kinds or ()} or DEFAULT_BUSINESS_TYPES)


def lead_business_types(lead) -> list[str]:
    """A lead's selection: what the public lead form captured, else its descriptive kind mapped."""
    return list(lead.business_types) if lead.business_types else platform_business_types([lead.business_type])
