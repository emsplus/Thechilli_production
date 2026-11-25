"""Marketing team, referral and commission read views, aggregated from marketing-service through a client interface.
Read-only: approving/paying commissions stays in Portal C (maker-checker lives there)."""
from fastapi import APIRouter, Depends

from app.core import errors
from app.core.deps import Principal, require
from app.services.marketing_client import MarketingClient, MarketingUnavailable, get_marketing_client

router = APIRouter(tags=["marketing"])
STATUSES = ("pending", "approved", "paid")


def client() -> MarketingClient:
    try:
        return get_marketing_client()
    except MarketingUnavailable:
        raise errors.AppError(503, "marketing_unavailable", "marketing-service is not configured")


def _call(fn, *a):
    try:
        return fn(*a)
    except MarketingUnavailable as e:
        raise errors.AppError(502 if e.configured else 503, "marketing_unavailable", str(e))


def _balances(entries: list[dict]) -> dict[str, dict[str, int]]:
    """currency -> {pending_minor, approved_minor, paid_minor}; reversal rows carry negative amounts so they net out."""
    out: dict[str, dict[str, int]] = {}
    for e in entries:
        if e.get("status") in STATUSES:
            b = out.setdefault(e["currency"], {f"{s}_minor": 0 for s in STATUSES})
            b[f"{e['status']}_minor"] += int(e["amount_minor"])
    return out


@router.get("/marketing/team")
def team(_: Principal = Depends(require("marketing.read", staff_only=True)), mc: MarketingClient = Depends(client)):
    users, refs, entries = _call(mc.users), _call(mc.referrals), _call(mc.commission_entries)
    items = []
    for u in users:
        mine = [r for r in refs if r["owner_id"] == u["id"]]
        items.append({"id": u["id"], "name": u["name"], "email": u["email"], "role": u["role"], "is_active": u["is_active"],
                      "referral_codes": len(mine), "referral_uses": sum(int(r.get("uses") or 0) for r in mine),
                      "commission": _balances([e for e in entries if e["user_id"] == u["id"]])})
    return {"items": items, "total": len(items)}


@router.get("/marketing/referrals")
def referrals(_: Principal = Depends(require("marketing.read", staff_only=True)), mc: MarketingClient = Depends(client)):
    users = {u["id"]: u for u in _call(mc.users)}
    items = [{**{k: r.get(k) for k in ("id", "code", "owner_id", "campaign_id", "is_active", "max_uses", "expires_at", "created_at")},
              "uses": int(r.get("uses") or 0), "owner_name": users.get(r["owner_id"], {}).get("name")} for r in _call(mc.referrals)]
    return {"items": items, "total": len(items)}


@router.get("/marketing/commissions")
def commissions(status: str | None = None, _: Principal = Depends(require("marketing.read", staff_only=True)),
                mc: MarketingClient = Depends(client)):
    if status and status not in ("pending", "approved", "rejected", "paid"):
        raise errors.bad("Unknown status", "bad_status")
    users = {u["id"]: u for u in _call(mc.users)}
    entries = _call(mc.commission_entries, status)
    keep = ("id", "kind", "user_id", "application_id", "base_amount_minor", "amount_minor", "currency", "status", "decided_at", "created_at")
    rows = [{**{k: e.get(k) for k in keep}, "user_name": users.get(e["user_id"], {}).get("name")} for e in entries]
    by_user: dict[str, dict] = {}
    for e in entries:
        by_user.setdefault(e["user_id"], []).append(e)
    return {"items": rows, "total": len(rows), "balances": _balances(entries),
            "by_user": [{"user_id": uid, "user_name": users.get(uid, {}).get("name"), "balances": _balances(es)} for uid, es in by_user.items()],
            "rules": _call(mc.commission_rules)}
