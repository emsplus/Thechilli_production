import uuid

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import Lead, LeadStage, STAGE_ORDER


def find_duplicates(db: Session, phone_norm: str | None, email_norm: str | None,
                    exclude_id: uuid.UUID | None = None) -> list[Lead]:
    conds = []
    if phone_norm:
        conds.append(Lead.phone_norm == phone_norm)
    if email_norm:
        conds.append(Lead.email_norm == email_norm)
    if not conds:
        return []
    q = select(Lead).where(or_(*conds)).order_by(Lead.created_at)
    if exclude_id:
        q = q.where(Lead.id != exclude_id)
    return list(db.scalars(q))


def check_transition(cur: LeadStage, new: LeadStage, lost_reason: str | None) -> None:
    """new..negotiation move freely forward or one step back; `lost` needs a reason from any open stage and can be
    re-opened to `new`; `won` is terminal and reached only through provisioning."""
    if new == LeadStage.won:
        raise HTTPException(409, "A lead becomes 'won' only when its onboarding application is provisioned")
    if cur == LeadStage.won:
        raise HTTPException(409, "A won lead cannot change stage")
    if cur == new:
        raise HTTPException(409, f"Lead is already '{new.value}'")
    if new == LeadStage.lost:
        if not lost_reason or not lost_reason.strip():
            raise HTTPException(422, "lost_reason is required when moving a lead to 'lost'")
        return
    if cur == LeadStage.lost:
        if new != LeadStage.new:
            raise HTTPException(409, "A lost lead can only be re-opened to 'new'")
        return
    if STAGE_ORDER.index(new) < STAGE_ORDER.index(cur) - 1:
        raise HTTPException(409, f"Cannot move back from '{cur.value}' to '{new.value}'")


def merge(db: Session, target: Lead, source: Lead, actor_id) -> dict:
    """Fold `source` into `target` and delete `source`. History (activities, demos, applications, invitations,
    commission rows) moves to the target; empty target fields are filled from the source; the target keeps its stage
    unless the source is `won` (its application is provisioned and carries over)."""
    from sqlalchemy import delete, update

    from app.models import (Activity, CommissionEntry, Demo, OnboardingApplication, ReferralAttribution,
                            SignupInvitation)
    from app.models.enums import AppStatus
    from app.services import audit

    if target.id == source.id:
        raise HTTPException(422, "Cannot merge a lead into itself")

    def live_apps(lead):
        return db.scalar(select(OnboardingApplication.id).where(OnboardingApplication.lead_id == lead.id,
                                                                OnboardingApplication.status != AppStatus.cancelled))
    if live_apps(target) and live_apps(source):
        raise HTTPException(409, "Both leads have an onboarding application; cancel one before merging")
    moved = {}
    for name, model in (("activities", Activity), ("demos", Demo), ("applications", OnboardingApplication),
                        ("invitations", SignupInvitation), ("commission_entries", CommissionEntry)):
        moved[name] = db.execute(update(model).where(model.lead_id == source.id).values(lead_id=target.id)).rowcount
    if db.scalar(select(ReferralAttribution.id).where(ReferralAttribution.lead_id == target.id)):
        db.execute(delete(ReferralAttribution).where(ReferralAttribution.lead_id == source.id))
    else:
        db.execute(update(ReferralAttribution).where(ReferralAttribution.lead_id == source.id).values(lead_id=target.id))
    filled = []
    for f in ("phone", "email", "city", "business_type", "business_types", "owner_id", "campaign_id", "referral_code_id"):
        if getattr(target, f) is None and getattr(source, f) is not None:
            setattr(target, f, getattr(source, f))
            filled.append(f)
    target.phone_norm = target.phone_norm or source.phone_norm
    target.email_norm = target.email_norm or source.email_norm
    if source.notes:
        target.notes = f"{target.notes}\n\n[merged] {source.notes}" if target.notes else f"[merged] {source.notes}"
    if source.stage == LeadStage.won and target.stage != LeadStage.won:
        target.stage, target.lost_reason = LeadStage.won, None
    sid = source.id
    db.flush()
    db.delete(source)
    audit.record(db, actor_id, "lead.merged", "lead", target.id,
                 {"source_id": str(sid), "moved": moved, "filled_fields": filled})
    return {"moved": moved, "filled_fields": filled}
