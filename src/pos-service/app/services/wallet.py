"""Chilli wallet: metering and enforcement (docs/CHILLI_WALLET.md, docs/PAYG_BILLING.md). platform-core holds the wallet; pos-service

* REPORTS every finalized / voided bill: ``record_finalized`` / ``record_voided`` add a ``billing_usage_outbox`` row in the SAME
  transaction as the bill, so a bill is reported if and only if it exists (offline-synced bills too). ``run_once`` (background
  runner) sends due rows to platform-core ``POST /billing/tenants/{t}/usage`` (5 Chilli per bill, nothing during the trial);
  failures are retried with back-off and a row is never dropped. The key is the ROOT bill of an amendment chain, so a corrected
  bill is never charged twice; platform-core dedupes (bill, event) again, so a resend is harmless.
* ENFORCES at order creation only (``guard_new_order``, CHILLI_ENFORCE=on): state ``blocked`` (balance <= -CHILLI_GRACE_ORDERS x fee) -> 402 ``chilli_empty``,
  ``suspended`` -> 402 ``billing_suspended``. Never blocked: an order that is already open (more items, KOT, bill, payment,
  voids, amendments), reports, cash drawer / Z close, recharge, and the offline sync of orders / bills already created on a
  device. When the wallet state cannot be known (platform-core not configured, unreachable, tenant unknown to it) nothing is
  blocked.
* EXPOSES the state: ``billing_for`` = platform-core's billing block (from the entitlements feed, cached for
  ENTITLEMENTS_CACHE_TTL_SECONDS) adjusted by this tenant's fees still waiting in the outbox.
"""
from __future__ import annotations

import contextvars
import logging
import math
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Protocol

import httpx
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import tenant_session
from app.models.core import Bill, BillingUsageOutbox
from app.services import entitlements
from app.services.entitlements import EntitlementError, Unmanaged

log = logging.getLogger("app.wallet")

LEASE_SECONDS = 60
_OFFLINE = object()
_offline: contextvars.ContextVar = contextvars.ContextVar("wallet_offline", default=None)


def now() -> datetime:
    return datetime.now(timezone.utc)


def paise(amount) -> int:
    return int((Decimal(amount or 0) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


# ------------------------------------------------------------------ metering (same transaction as the bill)
@contextmanager
def replaying(client_created_at: datetime | None):
    """Wrap the offline-sync replay of `finalize_bill`: the usage row is marked offline and carries the device's time (clamped
    to WALLET_OFFLINE_MAX_AGE_HOURS), so a bill taken during the free trial and synced after it is still free."""
    token = _offline.set(client_created_at if client_created_at is not None else _OFFLINE)
    try:
        yield
    finally:
        _offline.reset(token)


def root_bill(db: Session, bill: Bill) -> Bill:
    if bill.amends_bill_id is None:
        return bill
    return db.scalar(select(Bill).where(Bill.order_id == bill.order_id, Bill.amends_bill_id.is_(None))) or bill


def _enqueue(db: Session, bill: Bill, event: str, occurred_at: datetime, offline: bool) -> None:
    db.execute(pg_insert(BillingUsageOutbox).values(
        id=uuid.uuid4(), restaurant_id=bill.restaurant_id, bill_id=bill.id, event=event, outlet_id=bill.outlet_id,
        invoice_number=bill.invoice_number, bill_total_paise=paise(bill.total), occurred_at=occurred_at, offline=offline,
        status="pending", attempts=0, next_attempt_at=now(),
    ).on_conflict_do_nothing(constraint="uq_billing_usage_bill_event"))


def record_finalized(db: Session, bill: Bill) -> None:
    """Call inside the finalizing transaction, after the bill row is flushed. Amendment replacements are not reported."""
    if not settings.wallet_metering or bill.amends_bill_id is not None:
        return
    occurred, offline = bill.finalized_at or now(), False
    mark = _offline.get()
    if mark is not None:
        offline = True
        if isinstance(mark, datetime):
            m = mark if mark.tzinfo else mark.replace(tzinfo=timezone.utc)
            occurred = min(max(m, occurred - timedelta(hours=settings.wallet_offline_max_age_hours)), occurred)
    _enqueue(db, bill, "finalized", occurred, offline)


def record_voided(db: Session, bill: Bill) -> None:
    """Call inside the voiding transaction. The fee of the chain's root bill is credited back once by platform-core."""
    if not settings.wallet_metering:
        return
    _enqueue(db, root_bill(db, bill), "voided", bill.voided_at or now(), False)


# ------------------------------------------------------------------ state
def _parse_ts(v) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(v))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def chilli(paise: int):
    """1 rupee = 1 Chilli: whole number whenever it is one."""
    return paise // 100 if paise % 100 == 0 else round(paise / 100, 2)


LOCAL_BANNERS = {  # only used when the local state moved past what platform-core last said (texts: platform-core)
    "blocked": ("critical", "Recharge to continue. You have no Chilli left for new orders.",
                "जारी रखने के लिए रिचार्ज करें। नए ऑर्डर के लिए Chilli नहीं बचे।"),
    "grace": ("critical", "{orders} orders left before billing stops. Recharge now.",
              "बिलिंग रुकने से पहले {orders} ऑर्डर बाकी हैं। अभी रिचार्ज करें।"),
    "suspended": ("critical", "Billing is paused by Chilli support. Please contact support.",
                  "Chilli सपोर्ट ने बिलिंग रोक दी है। कृपया सपोर्ट से संपर्क करें।"),
}


def pending_fees(db: Session, restaurant_id, b: dict) -> int:
    """Bills finalized here whose fee platform-core has not applied yet (still in the outbox)."""
    trial_end = _parse_ts(b.get("trial_ends_at"))
    q = select(func.count()).select_from(BillingUsageOutbox).where(
        BillingUsageOutbox.restaurant_id == restaurant_id, BillingUsageOutbox.event == "finalized",
        BillingUsageOutbox.status.in_(("pending", "unmanaged")))
    if trial_end is not None:
        q = q.where(BillingUsageOutbox.occurred_at >= trial_end)
    if not b.get("charge_zero_bills"):
        q = q.where(BillingUsageOutbox.bill_total_paise > 0)
    return db.scalar(q) or 0


def local_view(db: Session, restaurant_id, b: dict, at: datetime | None = None) -> dict:
    """platform-core's block, re-evaluated now and with the fees still waiting in this tenant's outbox."""
    at = at or now()
    out = dict(b)
    debit = int(b.get("per_bill_paise") or 0)
    grace, low = int(b.get("grace_paise") or 0), int(b.get("low_balance_paise") or 0)
    trial_end = _parse_ts(b.get("trial_ends_at"))
    n = pending_fees(db, restaurant_id, b) if b.get("model") == "payg" else 0
    bal = int(b.get("balance_paise") or 0) - n * debit
    if b.get("model") != "payg":
        st = "active"
    elif b.get("state") == "suspended":
        st = "suspended"
    elif trial_end is not None and at < trial_end:
        st = "trial"
    elif bal <= -grace:  # Chilli: active > low (<= 100) > grace (<= 0, the next N orders still allowed) > blocked (<= -N x fee)
        st = "blocked"
    elif bal <= 0:
        st = "grace"
    elif bal <= low:
        st = "low"
    else:
        st = "active"
    left = max(0, (bal + grace) // debit) if debit and st not in ("trial", "suspended") else None
    out.update(state=st, balance_paise=bal, balance_chilli=chilli(bal), pending_bills=n, can_bill=st not in ("blocked", "suspended"),
               orders_left=left if st == "grace" else None, grace_orders=(grace // debit) if debit else 0, blocked=st == "blocked",
               enforce=settings.wallet_enforce == "on",
               days_left=max(0, math.ceil((trial_end - at).total_seconds() / 86400)) if trial_end else 0,
               in_grace=b.get("model") == "payg" and st == "grace",
               bills_left=left)
    if (st != b.get("state") or st == "grace") and st in LOCAL_BANNERS:  # grace: the count of orders left moves with every bill
        lvl, en, hi = LOCAL_BANNERS[st]
        out["banner"] = {"level": lvl, "code": st, "message": {"en": en.format(orders=left or 0), "hi": hi.format(orders=left or 0)}}
    return out


def billing_for(db: Session, restaurant_id) -> dict | None:
    """The tenant's billing block, or None when it cannot be known (platform-core not configured / unreachable / no block):
    callers must then NOT block anything. `source` says where it came from (live | stale)."""
    if not settings.platform_core_url and not isinstance(_client, FakePlatform):
        return None
    e = entitlements.cache().get(restaurant_id)
    if not e.billing:
        return None
    return {**local_view(db, restaurant_id, e.billing), "source": "live" if e.source == "live" else "stale"}


MESSAGES = {
    "chilli_empty": "Recharge to continue. You have no Chilli left, so new orders are paused. Orders that are already open can still be billed and paid.",
    "billing_suspended": "Billing is paused by Chilli support. New orders are paused. Orders that are already open can still be billed and paid. Please contact support.",
}
_refreshed: dict = {}  # tenant -> monotonic time of the last forced refresh before refusing (one live look per tenant per REFRESH_EVERY s)
REFRESH_EVERY = 5.0


def guard_new_order(db: Session, p, response=None) -> None:
    """Before creating a NEW order online. Fails open whenever the state is unknown or stale. Never called for an order that
    already exists (idempotent replays), for offline sync, or for anything that works on an open order / bill."""
    mode = settings.wallet_enforce
    if mode == "off" or getattr(p, "support", None):
        return
    b = billing_for(db, p.restaurant_id)
    if b is None:
        return
    if b["state"] in ("blocked", "suspended") and time.monotonic() - _refreshed.get(p.restaurant_id, -1e9) > REFRESH_EVERY:
        # about to refuse: look at platform-core now, the owner may have just recharged (cached answers live up to the TTL)
        _refreshed[p.restaurant_id] = time.monotonic()
        entitlements.cache().invalidate(str(p.restaurant_id))
        b = billing_for(db, p.restaurant_id)
        if b is None:
            return
    if response is not None:
        response.headers["X-Billing-State"] = b["state"]
    if b["state"] not in ("blocked", "suspended"):
        return
    code = "chilli_empty" if b["state"] == "blocked" else "billing_suspended"
    if mode == "on" and b["source"] == "live":
        raise EntitlementError(402, code, MESSAGES[code])
    log.warning("wallet(%s): would refuse a new order for tenant %s (%s, source %s)", mode, p.restaurant_id, code, b["source"])
    if response is not None:
        response.headers["X-Billing-Warning"] = code


# ------------------------------------------------------------------ platform-core client
class BillingClient(Protocol):
    def report(self, tenant_id: str, events: list[dict]) -> dict:
        """POST usage; returns {results, billing}. Raises Unmanaged for 404, anything else for an outage."""

    def call(self, method: str, tenant_id: str, path: str, params: dict | None = None, body: dict | None = None) -> httpx.Response:
        """Proxy one owner read / top-up intent to /billing/tenants/{t}{path}."""


class HttpBillingClient:
    def __init__(self, transport: httpx.BaseTransport | None = None):
        self.transport = transport

    def _base(self) -> tuple[str, str]:
        base, key = settings.platform_core_url.rstrip("/"), settings.platform_service_key.get_secret_value()
        if not base or not key:
            raise RuntimeError("PLATFORM_CORE_URL / PLATFORM_SERVICE_KEY are not configured")
        return base, key

    def report(self, tenant_id: str, events: list[dict]) -> dict:
        r = self.call("POST", tenant_id, "/usage", body={"events": events})
        if r.status_code == 404:
            raise Unmanaged(tenant_id)
        if r.status_code != 200:
            raise RuntimeError(f"platform-core answered {r.status_code}")
        return r.json()

    def call(self, method, tenant_id, path, params=None, body=None) -> httpx.Response:
        base, key = self._base()
        with httpx.Client(timeout=settings.billing_proxy_timeout_seconds, transport=self.transport) as c:
            return c.request(method, f"{base}/billing/tenants/{tenant_id}{path}", params=params, json=body,
                             headers={"X-Service-Key": key})


class FakePlatform:
    """For tests: platform-core's wallet rules in memory, acting as BOTH the entitlement client (its billing block) and the
    billing client. `topup(t, paise)`, `end_trial(t)`, `suspend(t)`; `down = True` simulates an outage."""

    def __init__(self, per_bill: int = 500, grace: int = 10000, low: int = 10000, trial_days: int = 7):
        self.per_bill, self.grace, self.low, self.trial_days = per_bill, grace, low, trial_days
        self.w: dict[str, dict] = {}
        self.seen: dict[tuple, dict] = {}
        self.ledger: dict[str, list] = {}
        self.down = False
        self.unmanaged: set[str] = set()
        self.reports: list[tuple[str, list]] = []
        self.topup_enabled = False
        self.intents: dict[str, dict] = {}

    def _t(self, tid) -> dict:
        return self.w.setdefault(str(tid), {"balance": 0, "trial_end": now() + timedelta(days=self.trial_days), "suspended": False})

    def topup(self, tid, amount):
        self._t(tid)["balance"] += amount
        self.ledger.setdefault(str(tid), []).append({"kind": "topup", "amount_paise": amount})

    def pay_intent(self, iid):
        """What the verified Razorpay webhook does in platform-core: credit the intent's amount once."""
        i = self.intents[iid]
        if i["status"] != "paid":
            i["status"] = "paid"
            self.topup(i["tenant"], i["amount"])

    def end_trial(self, tid):
        self._t(tid)["trial_end"] = now() - timedelta(minutes=1)

    def suspend(self, tid, on=True):
        self._t(tid)["suspended"] = on

    def block(self, tid) -> dict:
        w = self._t(tid)
        st = ("suspended" if w["suspended"] else "trial" if now() < w["trial_end"] else
              "blocked" if w["balance"] <= -self.grace else "grace" if w["balance"] <= 0 else
              "low" if w["balance"] <= self.low else "active")
        return {"state": st, "model": "payg", "trial_ends_at": w["trial_end"].isoformat(), "days_left": 0,
                "balance_paise": w["balance"], "per_bill_paise": self.per_bill, "fee_gst_mode": "inclusive",
                "charge_zero_bills": False, "low_balance_paise": self.low, "grace_paise": self.grace, "min_topup_paise": 0,
                "bonus_tiers": [], "can_bill": st not in ("blocked", "suspended"), "in_grace": st == "grace", "bills_left": None,
                "suspended_reason": None, "banner": None, "topup_online": False}

    # entitlement client
    def fetch(self, tenant_id: str):
        if self.down:
            raise RuntimeError("platform-core unreachable")
        if str(tenant_id) in self.unmanaged:
            raise Unmanaged(tenant_id)
        return entitlements.Entitlements(status="active", plan_code="starter", plan_name="Starter", billing=self.block(tenant_id))

    # billing client
    def report(self, tenant_id, events):
        if self.down:
            raise RuntimeError("platform-core unreachable")
        if str(tenant_id) in self.unmanaged:
            raise Unmanaged(tenant_id)
        self.reports.append((str(tenant_id), events))
        w, results = self._t(tenant_id), []
        for ev in events:
            key = (str(tenant_id), ev["bill_id"], ev["event"])
            if key in self.seen:
                results.append({**self.seen[key], "status": "duplicate"})
                continue
            out, charged = "nothing_to_credit", 0
            if ev["event"] == "finalized":
                at = datetime.fromisoformat(ev["occurred_at"])
                out = "trial" if at < w["trial_end"] else "zero_total" if ev["bill_total_paise"] <= 0 else "charged"
                if out == "charged":
                    w["balance"] -= self.per_bill
                    charged = self.per_bill
            elif self.seen.get((str(tenant_id), ev["bill_id"], "finalized"), {}).get("outcome") == "charged":
                w["balance"] += self.per_bill
                out, charged = "credited_back", self.per_bill
            res = {"bill_id": ev["bill_id"], "event": ev["event"], "status": "applied", "outcome": out, "charged_paise": charged}
            self.seen[key] = res
            if charged:
                self.ledger.setdefault(str(tenant_id), []).append({"kind": "bill_fee" if ev["event"] == "finalized" else "void_credit_back",
                                                                   "amount_paise": -charged if ev["event"] == "finalized" else charged})
            results.append(res)
        return {"results": results, "billing": self.block(tenant_id)}

    def call(self, method, tenant_id, path, params=None, body=None) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("platform-core unreachable")
        if path == "/wallet":
            return httpx.Response(200, json={"tenant_id": str(tenant_id), "billing": self.block(tenant_id)})
        if path == "/ledger":
            items = list(reversed(self.ledger.get(str(tenant_id), [])))
            return httpx.Response(200, json={"items": items, "total": len(items), "limit": 50, "offset": 0, "params": params})
        if path == "/usage":
            if (params or {}).get("format") == "csv":
                return httpx.Response(200, text="at,kind\r\n", headers={"content-type": "text/csv; charset=utf-8",
                                                                         "content-disposition": 'attachment; filename="u.csv"'})
            return httpx.Response(200, json={"tenant_id": str(tenant_id), "month": (params or {}).get("month")})
        if path == "/topups/intent":
            if not self.topup_enabled:
                return httpx.Response(503, json={"error": {"code": "topup_unavailable", "message": "Recharge is not available yet."}})
            amt = int((body or {}).get("amount_paise") or 0)
            if amt % 100 or amt < 200000 or amt > 10_000_000:
                return httpx.Response(400, json={"error": {"code": "below_min_topup", "message": "The minimum recharge is ₹2,000"}})
            iid = str(uuid.uuid4())
            self.intents[iid] = {"tenant": str(tenant_id), "amount": amt, "status": "created"}
            return httpx.Response(201, json={"intent": {"id": iid, "status": "created", "amount_paise": amt, "chilli": amt // 100,
                                                        "payment_url": f"https://rzp.fake/{iid}"},
                                             "checkout": {"kind": "payment_link", "url": f"https://rzp.fake/{iid}"}, "provider": "razorpay"})
        if path.startswith("/topups/"):
            i = self.intents.get(path.rsplit("/", 1)[1])
            if i is None or i["tenant"] != str(tenant_id):
                return httpx.Response(404, json={"error": {"code": "not_found", "message": "Recharge not found"}})
            return httpx.Response(200, json={"intent": {"id": path.rsplit("/", 1)[1], "status": i["status"], "amount_paise": i["amount"]},
                                             "billing": self.block(tenant_id)})
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "Not found"}})


_client: BillingClient | None = None
_client_lock = threading.Lock()


def client() -> BillingClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = HttpBillingClient()
        return _client


def set_client(c: BillingClient | None) -> None:
    """Install a client (tests: a FakePlatform, which should also be the entitlements client); None restores HTTP."""
    global _client
    with _client_lock:
        _client = c


# ------------------------------------------------------------------ runner
def _backoff(attempts: int) -> int:
    return min(settings.billing_usage_backoff_base_seconds * 2 ** max(attempts - 1, 0), settings.billing_usage_backoff_max_seconds)


def _claim(db: Session) -> list[BillingUsageOutbox]:
    rows = db.scalars(select(BillingUsageOutbox).where(
        BillingUsageOutbox.status.in_(("pending", "unmanaged")), BillingUsageOutbox.next_attempt_at <= now())
        .order_by(BillingUsageOutbox.created_at, BillingUsageOutbox.id).limit(settings.billing_usage_batch)
        .with_for_update(skip_locked=True)).all()
    for r in rows:
        r.next_attempt_at = now() + timedelta(seconds=LEASE_SECONDS)
    db.commit()
    return rows


def send_tenant(tenant_id) -> int:
    """Sends one batch of the tenant's due rows. Returns the number acknowledged by platform-core."""
    with tenant_session(tenant_id) as db:
        rows = _claim(db)
        if not rows:
            return 0
        events = [{"bill_id": str(r.bill_id), "event": r.event, "bill_total_paise": r.bill_total_paise,
                   "occurred_at": r.occurred_at.isoformat(), "offline": r.offline,
                   "outlet_id": str(r.outlet_id) if r.outlet_id else None, "invoice_number": r.invoice_number} for r in rows]
        try:
            res = client().report(str(tenant_id), events)
        except Unmanaged:
            for r in rows:
                r.status, r.last_error = "unmanaged", "tenant unknown to platform-core"
                r.next_attempt_at = now() + timedelta(seconds=settings.billing_usage_unmanaged_retry_seconds)
            db.commit()
            return 0
        except Exception as e:  # noqa: BLE001 - any failure is a failed attempt; the rows stay and are retried
            for r in rows:
                r.attempts += 1
                r.last_error = f"{type(e).__name__}: {e}"[:300]
                r.next_attempt_at = now() + timedelta(seconds=_backoff(r.attempts))
            db.commit()
            log.warning("billing usage for tenant %s not sent (%d events): %s", tenant_id, len(rows), type(e).__name__)
            return 0
        by = {(x.get("bill_id"), x.get("event")): x for x in res.get("results") or []}
        for r in rows:
            got = by.get((str(r.bill_id), r.event)) or {}
            r.status, r.sent_at, r.last_error = "sent", now(), None
            r.outcome, r.charged_paise = got.get("outcome"), got.get("charged_paise")
        db.commit()
        if isinstance(res.get("billing"), dict):
            entitlements.cache().set_billing(tenant_id, res["billing"])
        return len(rows)


def configured() -> bool:
    return isinstance(_client, FakePlatform) or bool(settings.platform_core_url and settings.platform_service_key.get_secret_value())


def run_once() -> int:
    """One pass over every tenant with due usage rows. Returns the number of events acknowledged."""
    if not configured():
        return 0
    with SessionLocal() as db:
        tenants = [r.tenant_id for r in db.execute(text("SELECT tenant_id FROM billing_usage_tenants(:n)"), {"n": now()})]
    sent = 0
    for tid in tenants:
        while True:  # drain the tenant in batches
            n = send_tenant(tid)
            sent += n
            if n < settings.billing_usage_batch:
                break
    return sent


def start_runner() -> None:
    every = settings.billing_usage_sweep_seconds
    if every <= 0:
        return

    def loop() -> None:
        while True:
            time.sleep(every)
            try:
                run_once()
            except Exception:  # noqa: BLE001 - the runner must survive a bad cycle
                log.exception("billing usage run failed")

    threading.Thread(target=loop, name="billing-usage", daemon=True).start()
