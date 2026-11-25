"""The restaurant's own Chilli credit (PAYG wallet, docs/PAYG_BILLING.md). platform-core holds the wallet; these routes proxy it
for the signed-in tenant ONLY (the tenant id comes from the token, never from the request) with the service key.
billing.view: owner + manager. billing.topup: owner."""
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.services import audit, entitlements, wallet
from app.services.entitlements import EntitlementError

router = APIRouter(tags=["wallet"])
VIEW = require_perm(P.BILLING_VIEW)
UNAVAILABLE = "Chilli credit details are temporarily unavailable. Billing itself keeps working."


def _call(method: str, p: Principal, path: str, params: dict | None = None, body: dict | None = None):
    try:
        r = wallet.client().call(method, str(p.restaurant_id), path, {k: v for k, v in (params or {}).items() if v is not None}, body)
    except Exception:  # noqa: BLE001 - outage / not configured: the owner sees a clear message, nothing else is affected
        raise EntitlementError(503, "billing_unavailable", UNAVAILABLE)
    if r.status_code >= 400:
        try:
            err = (r.json() or {}).get("error") or {}
        except ValueError:
            err = {}
        if r.status_code in (401, 403) or r.status_code >= 500 and err.get("code") not in ("topup_unavailable", "payment_provider_unavailable"):
            raise EntitlementError(503, "billing_unavailable", UNAVAILABLE)  # our key / their outage: not the owner's problem
        raise EntitlementError(r.status_code, err.get("code") or "billing_error", err.get("message") or "Request failed")
    return r


def _passthrough(r) -> Response:
    if r.headers.get("content-type", "").startswith("text/csv"):
        return Response(r.content, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": r.headers.get("content-disposition", 'attachment; filename="usage.csv"')})
    return Response(r.content, media_type="application/json")


@router.get("/billing/wallet")
def my_wallet(p: Principal = Depends(VIEW), db: Session = Depends(get_db)):
    """Balance, trial and state of this restaurant's credit: `billing` = {state trial|active|low|grace|blocked|suspended, trial_ends_at,
    days_left, balance_paise, per_bill_paise, can_bill, bills_left, banner, ...}; `source` live (platform-core now) |
    cached (last known, platform-core unreachable) | unavailable (billing null)."""
    try:
        r = wallet.client().call("GET", str(p.restaurant_id), "/wallet")
        if r.status_code == 200:
            raw = r.json()["billing"]
            entitlements.cache().set_billing(p.restaurant_id, raw)  # a recharge unblocks new orders at once, not after the TTL
            return {"billing": {**wallet.local_view(db, p.restaurant_id, raw), "source": "live"}, "source": "live"}
    except Exception:  # noqa: BLE001
        pass
    b = wallet.billing_for(db, p.restaurant_id)
    return {"billing": b, "source": "cached" if b else "unavailable"}


@router.get("/billing/ledger")
def my_ledger(from_: date | None = Query(None, alias="from"), to: date | None = None, kind: str | None = Query(None, max_length=20),
              limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), p: Principal = Depends(VIEW)):
    """Credit movements, newest first: topup, promo, bill_fee (-), void_credit_back (+), adjustment. Paginated."""
    return _passthrough(_call("GET", p, "/ledger", {"from": from_.isoformat() if from_ else None, "to": to.isoformat() if to else None,
                                                    "kind": kind, "limit": limit, "offset": offset}))


@router.get("/billing/usage")
def my_usage(month: str | None = Query(None, pattern=r"^\d{4}-\d{2}$"), format: str = Query("json", pattern="^(json|csv)$"),
             p: Principal = Depends(VIEW)):
    """Monthly statement: bills charged / free, fees, credit-backs, top-ups, opening and closing balance (JSON or CSV)."""
    return _passthrough(_call("GET", p, "/usage", {"month": month, "format": format}))


@router.get("/billing/receipts")
def my_receipts(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), p: Principal = Depends(VIEW)):
    return _passthrough(_call("GET", p, "/receipts", {"limit": limit, "offset": offset}))


@router.get("/billing/receipts/{receipt_id}")
def my_receipt(receipt_id: uuid.UUID, p: Principal = Depends(VIEW)):
    return _passthrough(_call("GET", p, f"/receipts/{receipt_id}"))


class TopupIntentIn(BaseModel):
    amount_paise: int = Field(gt=0, le=10**10)  # whole rupees in paise: 200000 = ₹2,000 = 2,000 Chilli


@router.post("/billing/topups/intent", status_code=201)
def topup_intent(data: TopupIntentIn, p: Principal = Depends(require_perm(P.BILLING_TOPUP)), db: Session = Depends(get_db)):
    """Recharge (owner only): creates a Razorpay payment link on Chilli's account. `checkout.url` is where the owner pays and
    `intent.id` is what to poll with GET /billing/topups/{id} after the return. 400 below_min_topup / above_max_topup /
    not_whole_rupees, 503 topup_unavailable (not set up) or payment_provider_unavailable."""
    r = _call("POST", p, "/topups/intent", body={"amount_paise": data.amount_paise, "requested_by": str(p.user_id)})
    audit.record(db, p, "billing.topup_intent", "restaurant", p.restaurant_id, {"amount_paise": data.amount_paise})
    db.commit()
    return r.json()


@router.get("/billing/topups/{topup_id}")
def topup_status(topup_id: uuid.UUID, p: Principal = Depends(require_perm(P.BILLING_TOPUP)), db: Session = Depends(get_db)):
    """A recharge after the owner comes back from Razorpay: `intent.status` created | paid | expired and the wallet block. When it
    is paid the new balance is already in `billing` (and new orders are unblocked)."""
    out = _call("GET", p, f"/topups/{topup_id}").json()
    if isinstance(out.get("billing"), dict):
        entitlements.cache().set_billing(p.restaurant_id, out["billing"])
        out["billing"] = {**wallet.local_view(db, p.restaurant_id, out["billing"]), "source": "live"}
    return out


@router.get("/billing/topups")
def my_topups(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0), p: Principal = Depends(require_perm(P.BILLING_TOPUP))):
    return _passthrough(_call("GET", p, "/topups", {"limit": limit, "offset": offset}))
