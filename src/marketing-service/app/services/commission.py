"""Commission math and ledger generation. All money is integer minor units; no floats anywhere."""
import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (Calc, CommissionEntry, CommissionRule, EntryKind, EntryStatus, Lead, OnboardingApplication,
                        Recipient, ReferralCode)
from app.services import audit


def compute_amount(calc: Calc, base_minor: int, flat_minor: int = 0, rate_bps: int = 0,
                   cap_minor: int | None = None) -> int:
    """flat: the flat amount. percent_bps: base * bps / 10000 rounded half up (integer arithmetic only).
    The result is clamped to `cap_minor` when set. Deterministic for identical inputs."""
    if base_minor < 0 or flat_minor < 0 or not 0 <= rate_bps <= 10000 or (cap_minor is not None and cap_minor < 0):
        raise ValueError("negative or out-of-range commission input")
    amount = flat_minor if calc == Calc.flat else (base_minor * rate_bps + 5000) // 10000
    return min(amount, cap_minor) if cap_minor is not None else amount


def _rule_applies(rule: CommissionRule, app: OnboardingApplication, today: date) -> bool:
    return (rule.is_active and rule.currency == app.currency and app.contract_value_minor >= rule.min_base_minor
            and (rule.valid_from is None or rule.valid_from <= today)
            and (rule.valid_to is None or today <= rule.valid_to))


def generate_for_activation(db: Session, app: OnboardingApplication, today: date) -> list[CommissionEntry]:
    """Pending ledger entries for every applicable active rule when an application is provisioned.
    Idempotent: (rule, application, user) is unique, existing rows are never duplicated."""
    lead = db.get(Lead, app.lead_id) if app.lead_id else None
    ref = db.get(ReferralCode, app.referral_code_id) if app.referral_code_id else None
    who: dict[Recipient, uuid.UUID | None] = {
        Recipient.lead_owner: lead.owner_id if lead else None,
        Recipient.application_agent: app.agent_id,
        Recipient.referrer: ref.owner_id if ref else None,
    }
    created = []
    for rule in db.scalars(select(CommissionRule).order_by(CommissionRule.created_at, CommissionRule.name)):
        user_id = who[rule.recipient]
        if user_id is None or not _rule_applies(rule, app, today):
            continue
        exists = db.scalar(select(CommissionEntry.id).where(
            CommissionEntry.rule_id == rule.id, CommissionEntry.application_id == app.id,
            CommissionEntry.user_id == user_id))
        if exists:
            continue
        amount = compute_amount(rule.calc, app.contract_value_minor, rule.flat_amount_minor, rule.rate_bps,
                                rule.cap_minor)
        entry = CommissionEntry(
            kind=EntryKind.commission, rule_id=rule.id, user_id=user_id, application_id=app.id, lead_id=app.lead_id,
            base_amount_minor=app.contract_value_minor, amount_minor=amount, currency=app.currency,
            status=EntryStatus.pending,
            rule_snapshot={"name": rule.name, "recipient": rule.recipient.value, "calc": rule.calc.value,
                           "flat_amount_minor": rule.flat_amount_minor, "rate_bps": rule.rate_bps,
                           "cap_minor": rule.cap_minor})
        db.add(entry)
        created.append(entry)
    db.flush()
    for e in created:
        audit.record(db, None, "commission.generated", "commission_entry", e.id,
                     {"application_id": str(app.id), "amount_minor": e.amount_minor})
    return created
