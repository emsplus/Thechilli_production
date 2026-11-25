"""Print queue, hub pairing and automatic printing (docs/print-hub-contract.md).

Automatic printing (`auto_print_bill`, `auto_print_kot`) runs AFTER the sale / KOT is committed, in its OWN database session, and
swallows every error (logged), so printing can never fail or roll back a sale. Jobs are deduplicated by the unique key
(printer, kind, ref, copy, reprint): a replayed request, a finalize retry or an offline-sync replay never prints twice."""
import asyncio
import hashlib
import hmac
import logging
import secrets
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from sqlalchemy import and_, func, not_, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import bind_tenant, tenant_session
from app.models.core import (
    Bill, Category, HubPairing, Kot, MenuItem, Order, PrintHub, PrintJob, Printer, Restaurant,
)
from app.services import abuse, audit, escpos, outlets
from app.services.receipt_links import TokenBucket

log = logging.getLogger("app.printing")

STALE_SECONDS = 60
ONLINE_SECONDS = 45
PAIRING_MINUTES = 15
MAX_WAIT = 25
POLL_INTERVAL = settings.print_poll_interval_seconds  # first wait between database checks while a long poll idles ...
POLL_INTERVAL_MAX = settings.print_poll_interval_max_seconds  # ... growing x1.5 per idle check up to this (a quiet hub costs few queries)
POLL_BACKOFF = 1.5
CLAIM_BATCH = 10
PAIR_PER_MINUTE = 10  # pairing attempts per client IP
EXISTING_BILL_WINDOW = timedelta(minutes=15)  # a finalize retry heals a missed auto-print only this long after the sale
# A job the printer could not take yet waits a little longer after each failure (settings.print_retry_delays); the last failure is final.
# A slip nobody collected in time is dropped instead of printing hours later (a kitchen must never cook an old order), and an order
# taken OFFLINE long ago is not printed automatically when it finally syncs: it shows as "failed" with a Reprint button instead.
MAX_AGE = {"kot": timedelta(minutes=30), "bill": timedelta(hours=6), "test": timedelta(minutes=10)}
OFFLINE_AUTO_WINDOW = {"kot": timedelta(minutes=30), "bill": timedelta(hours=2)}
_old_operation: ContextVar[timedelta | None] = ContextVar("print_old_operation", default=None)


def retry_delays() -> list[int]:
    try:
        d = [max(0, int(x)) for x in settings.print_retry_delays.split(",") if x.strip()]
    except ValueError:
        d = []
    return d or [5, 15, 30, 60, 120, 180, 300]


def max_attempts() -> int:
    return len(retry_delays()) + 1


@contextmanager
def replaying(client_created_at: datetime | None, kind: str):
    """Wrap an offline-sync replay of `send_kot` / `finalize_bill`: when the operation was taken longer ago than the auto-print
    window, its slip is not auto-printed (it is recorded as a failed job with a Reprint button)."""
    age = now() - client_created_at if client_created_at is not None else None
    token = _old_operation.set(age if age is not None and age > OFFLINE_AUTO_WINDOW[kind] else None)
    try:
        yield
    finally:
        _old_operation.reset(token)

pair_limiter = TokenBucket()


def now() -> datetime:
    return datetime.now(timezone.utc)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


hash_token = hash_code = _hash


# ------------------------------------------------------------------------------------------------ pairing / hub auth
PAIR_CODE_LENGTH = 10  # 32^10 = 2^50 codes; the hub does not say which restaurant it is for, so the code alone finds the tenant
PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # upper-case alphanumerics without the look-alikes 0/O and 1/I


def normalize_code(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def create_pairing(db: Session, p) -> tuple[str, HubPairing]:
    for _ in range(20):  # the code must be unique among live codes, since the hub does not say which restaurant it is for
        code = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(PAIR_CODE_LENGTH))
        h = hash_code(code)
        live = db.scalar(select(HubPairing.id).where(HubPairing.code_hash == h, HubPairing.used_at.is_(None),
                                                     HubPairing.expires_at > now()).limit(1))
        if not live:
            break
    row = HubPairing(code_hash=h, restaurant_id=p.restaurant_id, outlet_id=outlets.outlet_of(db, p), created_by=p.user_id,
                     expires_at=now() + timedelta(minutes=PAIRING_MINUTES))
    db.add(row)
    audit.record(db, p, "print.hub.pairing", "print_hub", None, {"expires_at": row.expires_at.isoformat()})
    db.commit()
    return code, row  # the clear code is returned once and never stored


def _pair_keys(ip: str, code_hash: str) -> list[str]:
    return [f"pair:ip:{ip}", f"pair:code:{code_hash}", "pair:global"]


def pair_hub(db: Session, code: str, name: str, os_name: str | None, version: str | None, ip: str) -> tuple[str, PrintHub]:
    """Claims a pairing code for a hub. Brute force is limited three ways, all in the database (shared by every worker): per
    client IP, per code, and globally. Only FAILED attempts count; reaching a limit locks that key for PAIR_LOCKOUT_MINUTES
    and a locked key refuses even a correct code (so a brute-forcer cannot learn whether a guess was right)."""
    code = normalize_code(code)
    code_hash = hash_code(code)
    keys = _pair_keys(ip, code_hash)
    if not pair_limiter.allow(ip, PAIR_PER_MINUTE):  # cheap in-process pre-filter against request floods
        raise HTTPException(429, "Too many attempts. Wait a minute and try again.")
    wait = abuse.locked_for(keys)
    if wait:
        raise HTTPException(429, "Too many failed attempts. Try again later.", headers={"Retry-After": str(wait)})
    # single use, atomically: only one caller can flip used_at from NULL. The tenant AND outlet the code was issued for come
    # from the same statement (SECURITY DEFINER function, app/core/definer.py): the hub is bound to exactly those.
    used_at = now()
    row = db.execute(text("SELECT tenant_id, created_by, outlet_id FROM claim_hub_pairing(:h, :now)"),
                     {"h": code_hash, "now": used_at}).first()
    if not row:
        db.rollback()
        window = timedelta(minutes=settings.hub_pair_window_minutes)
        lockout = timedelta(minutes=settings.hub_pair_lockout_minutes)
        for key, limit in zip(keys, (settings.hub_pair_ip_max_failures, settings.hub_pair_code_max_failures,
                                     settings.hub_pair_global_max_failures)):
            abuse.hit(key, window=window, limit=limit, lockout=lockout)
        raise HTTPException(400, "Invalid or expired code")
    bind_tenant(db, row.tenant_id)
    outlet_id = row.outlet_id
    if outlet_id is None:  # a pairing created before outlets existed (migration backfills these; belt and braces)
        outlet_id = outlets.default_outlet(db, row.tenant_id).id
    token = secrets.token_urlsafe(32)  # 32 random bytes
    hub = PrintHub(restaurant_id=row.tenant_id, outlet_id=outlet_id, name=name, token_hash=hash_token(token), os=os_name,
                   version=version, last_seen_at=now(), system_printers=[], printer_status={})
    db.add(hub)
    db.flush()
    audit.record(db, SimpleNamespace(restaurant_id=row.tenant_id, user_id=row.created_by), "print.hub.pair",
                 "print_hub", hub.id, {"name": name, "os": os_name, "outlet_id": str(outlet_id), "ip": ip})
    db.commit()
    return token, hub


_hub_cache: dict[str, tuple[float, SimpleNamespace]] = {}  # token hash -> (expires at monotonic, hub). Positive hits only.
_hub_cache_lock = threading.Lock()


def forget_hub(hub_id: uuid.UUID | None = None) -> None:
    """Drops cached hub authentications (one hub, or all). Revocation also checks the database on every claim, so a stale
    cache entry can authenticate a request but never hand out a job."""
    with _hub_cache_lock:
        for k in [k for k, (_, h) in _hub_cache.items() if hub_id is None or h.id == hub_id]:
            del _hub_cache[k]


def authenticate_hub(token: str) -> SimpleNamespace:
    """The hub behind a bearer token, or 401. Own short session: a long poll must not hold one open. Successful lookups are
    cached for settings.hub_auth_cache_seconds (a long-polling hub would otherwise pay two queries per request)."""
    h = hash_token(token)
    ttl = settings.hub_auth_cache_seconds
    if ttl > 0:
        with _hub_cache_lock:
            hit = _hub_cache.get(h)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    with SessionLocal() as db:  # the tenant is not known yet: SECURITY DEFINER lookup by token hash, ids only
        found = db.execute(text("SELECT hub_id, tenant_id FROM hub_by_token(:h)"), {"h": h}).first()
    if found is None:
        raise HTTPException(401, "Invalid hub token")
    with tenant_session(found.tenant_id) as db:
        hub = db.get(PrintHub, found.hub_id)
        if hub is None or not hmac.compare_digest(hub.token_hash, h) or hub.revoked_at is not None:
            raise HTTPException(401, "Invalid hub token")
        out = SimpleNamespace(id=hub.id, restaurant_id=hub.restaurant_id)
    if ttl > 0:
        with _hub_cache_lock:
            if len(_hub_cache) > 1000:  # bounded: drop expired, then everything if still huge
                for k in [k for k, (t, _) in _hub_cache.items() if t <= time.monotonic()]:
                    del _hub_cache[k]
                if len(_hub_cache) > 1000:
                    _hub_cache.clear()
            _hub_cache[h] = (time.monotonic() + ttl, out)
    return out


def revoke_hub(db: Session, p, hub_id: uuid.UUID) -> None:
    hub = db.get(PrintHub, hub_id)
    if not hub or hub.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Hub not found")
    if hub.revoked_at is None:
        hub.revoked_at = now()
        forget_hub(hub.id)
        audit.record(db, p, "print.hub.revoke", "print_hub", hub.id, {"name": hub.name})
    db.commit()


def is_online(hub: PrintHub) -> bool:
    return hub.last_seen_at is not None and hub.revoked_at is None and \
        hub.last_seen_at > now() - timedelta(seconds=ONLINE_SECONDS)


def printer_statuses(db: Session, restaurant_id: uuid.UUID) -> dict[str, str]:
    """printer id -> status as last reported by the most recently seen online hub."""
    hubs = db.scalars(select(PrintHub).where(PrintHub.restaurant_id == restaurant_id, PrintHub.revoked_at.is_(None))
                      .order_by(PrintHub.last_seen_at.asc().nullsfirst())).all()
    out: dict[str, str] = {}
    for h in hubs:  # oldest first, so the freshest report wins
        if is_online(h):
            out.update({k: v for k, v in (h.printer_status or {}).items() if v in ("online", "offline", "unknown")})
    return out


def heartbeat(db: Session, hub_p, data) -> list[Printer]:
    hub = db.get(PrintHub, hub_p.id)
    if not hub or hub.revoked_at is not None:
        raise HTTPException(401, "Invalid hub token")
    hub.last_seen_at = now()
    if data.version is not None:
        hub.version = data.version
    if data.os is not None:
        hub.os = data.os
    hub.system_printers = list(data.system_printers)
    hub.printer_status = {str(k): (v if v in ("online", "offline", "unknown") else "unknown")
                          for k, v in data.printer_status.items()}
    db.commit()
    return list(db.scalars(select(Printer).where(Printer.restaurant_id == hub.restaurant_id, Printer.outlet_id == hub.outlet_id,
                                                 Printer.is_active.is_(True))
                           .order_by(Printer.created_at)))


# ------------------------------------------------------------------------------------------------ queue
def enqueue(db: Session, printer: Printer, kind: str, ref_id: uuid.UUID | None, payload: bytes, *, copy_no: int = 1,
            reprint_no: int = 0, created_by: uuid.UUID | None = None) -> uuid.UUID | None:
    """Inserts one job; None when the unique key already exists (nothing is inserted twice). Does not commit."""
    stmt = pg_insert(PrintJob).values(
        id=uuid.uuid4(), restaurant_id=printer.restaurant_id, outlet_id=printer.outlet_id, printer_id=printer.id, kind=kind, ref_id=ref_id,
        copy_no=copy_no, reprint_no=reprint_no, payload=payload, status="queued", attempts=0, created_by=created_by,
        created_at=now())
    if ref_id is not None:
        stmt = stmt.on_conflict_do_nothing(index_elements=["printer_id", "kind", "ref_id", "copy_no", "reprint_no"],
                                           index_where=PrintJob.ref_id.isnot(None))
    return db.execute(stmt.returning(PrintJob.id)).scalar()


def _fail_attempt(job: PrintJob, error: str) -> None:
    """One more failed attempt: back to the queue after the next delay, or final after the last one."""
    job.attempts += 1
    job.last_error = (error or "Print failed")[:500]
    if job.attempts >= max_attempts():
        job.status = "failed"
    else:
        delays = retry_delays()
        job.status, job.retry_at = "queued", now() + timedelta(seconds=delays[min(job.attempts, len(delays)) - 1])


def _requeue_stale(db: Session, restaurant_id: uuid.UUID) -> None:
    """A `sent` job the hub did not answer within 60 s counts as a failed attempt."""
    for job in db.scalars(select(PrintJob).where(
            PrintJob.restaurant_id == restaurant_id, PrintJob.status == "sent",
            PrintJob.sent_at < now() - timedelta(seconds=STALE_SECONDS)).with_for_update(skip_locked=True)):
        _fail_attempt(job, job.last_error or "The print hub did not confirm the print in time")


def _expire_old(db: Session, restaurant_id: uuid.UUID) -> None:
    """Queued slips that waited too long (hub or printer unreachable) are dropped, not printed late."""
    for kind, age in MAX_AGE.items():
        db.execute(update(PrintJob).where(
            PrintJob.restaurant_id == restaurant_id, PrintJob.status == "queued", PrintJob.kind == kind,
            PrintJob.created_at < now() - age,
        ).values(status="failed", last_error="Not printed: it waited too long for the printer. Reprint it if it is still needed."))


def _claim(hub_p, touch: bool) -> list[dict]:
    with tenant_session(hub_p.restaurant_id) as db:  # fresh short transaction per check
        hub = db.get(PrintHub, hub_p.id)
        if not hub or hub.revoked_at is not None:
            raise HTTPException(401, "Invalid hub token")
        if touch:
            hub.last_seen_at = now()
        # No UPDATE sweeps here (see sweep_all): this runs for every hub every poll. Slips already too old to print are simply not
        # handed out, whether or not the sweeper has marked them failed yet.
        too_old = or_(*[and_(PrintJob.kind == k, PrintJob.created_at < now() - age) for k, age in MAX_AGE.items()])
        rows = db.execute(
            select(PrintJob, Printer).join(Printer, Printer.id == PrintJob.printer_id)
            .where(PrintJob.restaurant_id == hub.restaurant_id, PrintJob.outlet_id == hub.outlet_id,  # a hub serves ONE outlet
                   PrintJob.status == "queued", Printer.is_active.is_(True), not_(too_old),
                   or_(PrintJob.retry_at.is_(None), PrintJob.retry_at <= now()))
            .order_by(PrintJob.created_at, PrintJob.id).limit(CLAIM_BATCH)
            .with_for_update(of=PrintJob, skip_locked=True)).all()
        out = []
        stamp = now()
        for job, pr in rows:
            job.status, job.sent_at = "sent", stamp
            out.append({"id": job.id, "attempts": job.attempts, "payload": bytes(job.payload),
                        "printer": {"id": pr.id, "connection": pr.connection, "host": pr.host, "port": pr.port,
                                    "system_name": pr.system_name}})
        db.commit()
        return out


def sweep(db: Session, restaurant_id: uuid.UUID) -> None:
    _requeue_stale(db, restaurant_id)
    _expire_old(db, restaurant_id)


def sweep_all() -> int:
    """Background sweep, off the poll path: a `sent` job the hub never answered counts as a failed attempt, and queued slips
    that waited too long are dropped. Only tenants that have something to sweep are visited (SECURITY DEFINER lookup)."""
    t = now()
    with SessionLocal() as db:
        tenants = [r.tenant_id for r in db.execute(
            text("SELECT tenant_id FROM print_sweep_tenants(:stale, :expire)"),
            {"stale": t - timedelta(seconds=STALE_SECONDS), "expire": t - min(MAX_AGE.values())})]
    for tid in tenants:
        with tenant_session(tid) as db:
            sweep(db, tid)
            db.commit()
    return len(tenants)


def start_sweeper() -> None:
    every = settings.print_sweep_seconds
    if every <= 0:
        return

    def loop() -> None:
        while True:
            time.sleep(every)
            try:
                sweep_all()
            except Exception:
                log.exception("print sweep failed")

    threading.Thread(target=loop, name="print-sweep", daemon=True).start()


def _next_interval(interval: float) -> float:
    return min(max(interval, 0.01) * POLL_BACKOFF, max(POLL_INTERVAL_MAX, POLL_INTERVAL))


def poll_jobs(hub_p, wait: float) -> list[dict]:
    """Blocking long poll (kept for callers outside the event loop): returns as soon as a job could be claimed, else []
    after `wait` seconds (max 25). Every check is its own short transaction, so no connection or lock is held while sleeping."""
    deadline = time.monotonic() + max(0.0, min(float(wait), MAX_WAIT))
    first, interval = True, POLL_INTERVAL
    while True:
        jobs = _claim(hub_p, touch=first)
        first = False
        left = deadline - time.monotonic()
        if jobs or left <= 0:
            return jobs
        time.sleep(min(interval, left))
        interval = _next_interval(interval)


async def poll_jobs_async(hub_p, wait: float) -> list[dict]:
    """The long poll the API uses: the wait is an `asyncio.sleep`, so an idle hub holds NO thread and NO connection; only each
    short check borrows a worker thread (and a pooled connection) for a few milliseconds. The interval backs off while idle."""
    deadline = time.monotonic() + max(0.0, min(float(wait), MAX_WAIT))
    first, interval = True, POLL_INTERVAL
    while True:
        jobs = await run_in_threadpool(_claim, hub_p, first)
        first = False
        left = deadline - time.monotonic()
        if jobs or left <= 0:
            return jobs
        await asyncio.sleep(min(interval, left))
        interval = _next_interval(interval)


def job_result(db: Session, hub_p, job_id: uuid.UUID, ok: bool, error: str | None) -> None:
    job = db.get(PrintJob, job_id, with_for_update=True)
    if not job or job.restaurant_id != hub_p.restaurant_id:
        raise HTTPException(404, "Job not found")
    if job.status in ("printed", "failed"):
        db.commit()
        return  # final already (a late duplicate report)
    if ok:
        job.status, job.printed_at, job.last_error = "printed", now(), None
    else:
        if job.status == "sent":  # a job already requeued by the stale sweep has had this attempt counted
            _fail_attempt(job, error or "Print failed")
        else:
            job.last_error = (error or "Print failed")[:500]
    db.commit()


# ------------------------------------------------------------------------------------------------ printers
def validate_printer(db: Session, restaurant_id: uuid.UUID, d: dict, outlet_id: uuid.UUID) -> None:
    if d["connection"] == "lan" and not d.get("host"):
        raise HTTPException(422, "A network (LAN) printer needs a host")
    if d["connection"] == "system" and not d.get("system_name"):
        raise HTTPException(422, "A USB / serial printer needs the name of its print queue on the hub PC")
    ids = set(d.get("kot_category_ids") or [])
    if ids:
        found = set(db.scalars(select(Category.id).where(Category.restaurant_id == restaurant_id, Category.id.in_(ids))))
        if found != ids:
            raise HTTPException(404, "Category not found")
    taken = db.scalar(select(Printer.id).where(Printer.restaurant_id == restaurant_id, Printer.outlet_id == outlet_id,
                                               Printer.name == d["name"], Printer.id != d.get("id")).limit(1))
    if taken:
        raise HTTPException(409, f"A printer named '{d['name']}' already exists")


def get_printer(db: Session, p, printer_id: uuid.UUID) -> Printer:
    pr = db.get(Printer, printer_id)
    if not pr or pr.restaurant_id != p.restaurant_id or not outlets.visible(p, pr):
        raise HTTPException(404, "Printer not found")
    return pr


def _opts(pr: Printer) -> dict:
    return {"columns": pr.columns, "codepage": pr.codepage, "cut": pr.cut}


def _tz(db: Session, restaurant_id: uuid.UUID) -> str:
    return db.get(Restaurant, restaurant_id).timezone


def _enqueue_copies(db: Session, pr: Printer, kind: str, ref_id, payload: bytes, reprint_no: int, created_by) -> list[uuid.UUID]:
    ids = [enqueue(db, pr, kind, ref_id, payload, copy_no=c, reprint_no=reprint_no, created_by=created_by)
           for c in range(1, pr.copies + 1)]
    return ids


def send_test_page(db: Session, p, pr: Printer, codepage: str | None = None) -> list[PrintJob]:
    if not pr.is_active:
        raise HTTPException(409, "Printer is switched off")
    opts = _opts(pr)
    if codepage:
        opts["codepage"] = codepage
    payload = escpos.render_test(pr.name, _tz(db, pr.restaurant_id), **opts)
    ids = [enqueue(db, pr, "test", None, payload, created_by=p.user_id)]
    audit.record(db, p, "print.test", "printer", pr.id, {"name": pr.name})
    db.commit()
    return _jobs(db, ids)


def _jobs(db: Session, ids) -> list[PrintJob]:
    ids = [i for i in ids if i]
    return list(db.scalars(select(PrintJob).where(PrintJob.id.in_(ids)).order_by(PrintJob.created_at, PrintJob.copy_no)))


# ------------------------------------------------------------------------------------------------ bill
def _job_exists(db: Session, pr: Printer, kind: str, ref_id: uuid.UUID, reprint_no: int = 0) -> bool:
    return db.scalar(select(PrintJob.id).where(PrintJob.printer_id == pr.id, PrintJob.kind == kind,
                                               PrintJob.ref_id == ref_id, PrintJob.reprint_no == reprint_no).limit(1)) is not None


def _hold_if_old_offline(db: Session, pr: Printer, kind: str, ref_id: uuid.UUID) -> None:
    """The order was taken offline long ago and only syncs now: do not print it automatically, keep it as a failed job the staff
    can Reprint (so nothing is lost silently and the kitchen is not flooded with old slips)."""
    age = _old_operation.get()
    if age is None:
        return
    minutes = int(age.total_seconds() // 60)
    when = f"{minutes} minutes" if minutes < 120 else f"{minutes // 60} hours"
    db.execute(update(PrintJob).where(PrintJob.printer_id == pr.id, PrintJob.kind == kind, PrintJob.ref_id == ref_id,
                                      PrintJob.reprint_no == 0, PrintJob.status == "queued")
               .values(status="failed", last_error=f"Not printed automatically: this order was taken offline {when} ago. Tap Reprint if it is still needed."))


def auto_print_bill(restaurant_id: uuid.UUID, bill_id: uuid.UUID, created_by: uuid.UUID | None = None) -> None:
    """Enqueue the bill on every active printer with auto_bill. NEVER raises."""
    try:
        with tenant_session(restaurant_id) as db:
            bill = db.get(Bill, bill_id)
            if not bill:
                return
            printers = db.scalars(select(Printer).where(Printer.restaurant_id == restaurant_id, Printer.outlet_id == bill.outlet_id,
                                                        Printer.is_active.is_(True), Printer.auto_bill.is_(True))
                                  .order_by(Printer.created_at)).all()
            if not printers:
                return
            tz = _tz(db, restaurant_id)
            for pr in printers:
                try:
                    if _job_exists(db, pr, "bill", bill.id):
                        continue
                    payload = escpos.render_bill(db, bill, tz, **_opts(pr))
                    _enqueue_copies(db, pr, "bill", bill.id, payload, 0, created_by)
                    _hold_if_old_offline(db, pr, "bill", bill.id)
                    db.commit()
                except Exception:
                    db.rollback()
                    log.exception("auto-print of bill %s on printer %s failed", bill_id, pr.id)
    except Exception:
        log.exception("auto-print of bill %s failed", bill_id)


def after_finalize(bill: Bill, user_id: uuid.UUID | None, *, existing: bool = False) -> None:
    """Hook for billing.finalize_bill (called after its commit). A finalize retry (`existing`) only re-enqueues for a bill
    that is still fresh, so an old bill is never printed by a later, unrelated request."""
    try:
        if existing and bill.finalized_at < now() - EXISTING_BILL_WINDOW:
            return
        auto_print_bill(bill.restaurant_id, bill.id, user_id)
    except Exception:
        log.exception("after_finalize hook failed")


def reprint_bill(db: Session, p, bill_id: uuid.UUID, printer_id: uuid.UUID | None) -> list[PrintJob]:
    bill = db.get(Bill, bill_id)
    if not bill or bill.restaurant_id != p.restaurant_id or not outlets.visible(p, bill):
        raise HTTPException(404, "Bill not found")
    if printer_id:
        pr = get_printer(db, p, printer_id)
    else:
        pr = db.scalar(select(Printer).where(Printer.restaurant_id == p.restaurant_id, Printer.outlet_id == bill.outlet_id,
                                             Printer.is_active.is_(True), Printer.role == "counter").order_by(Printer.created_at).limit(1))
        if not pr:
            raise HTTPException(409, "No counter printer is set up")
    if not pr.is_active:
        raise HTTPException(409, "Printer is switched off")
    tz = _tz(db, p.restaurant_id)
    ids = _reprint(db, p, pr, "bill", bill.id, lambda: escpos.render_bill(db, bill, tz, reprint=True, **_opts(pr)))
    audit.record(db, p, "bill.print", "bill", bill.id, {"printer": pr.name, "invoice": bill.invoice_number})
    db.commit()
    return _jobs(db, ids)


def _reprint(db: Session, p, pr: Printer, kind: str, ref_id: uuid.UUID, render) -> list[uuid.UUID]:
    """Next reprint_no for this printer / document; a concurrent reprint that took the same number is retried."""
    payload = render()
    for _ in range(5):
        top = db.scalar(select(func.max(PrintJob.reprint_no)).where(
            PrintJob.printer_id == pr.id, PrintJob.kind == kind, PrintJob.ref_id == ref_id)) or 0
        ids = _enqueue_copies(db, pr, kind, ref_id, payload, top + 1, p.user_id)
        if all(ids):
            return ids
        db.rollback()
    raise HTTPException(409, "Could not queue the reprint, try again")


# ------------------------------------------------------------------------------------------------ KOT
def _line_categories(db: Session, kot: Kot) -> list[uuid.UUID | None]:
    """Category of each KOT line. Lines carry their item_id; older KOTs (no item_id) are matched by item name."""
    by_name: dict[str, uuid.UUID] = {}
    order = db.get(Order, kot.order_id)
    if order:
        for l in order.lines:
            by_name.setdefault(l.item_name, l.item_id)
    item_ids = []
    for ln in kot.payload:
        iid = ln.get("item_id")
        try:
            item_ids.append(uuid.UUID(iid) if iid else by_name.get(ln.get("item")))
        except ValueError:
            item_ids.append(by_name.get(ln.get("item")))
    cats = dict(db.execute(select(MenuItem.id, MenuItem.category_id).where(MenuItem.id.in_({i for i in item_ids if i}))).all()) \
        if any(item_ids) else {}
    return [cats.get(i) if i else None for i in item_ids]


def kot_lines_for(printer: Printer, kot: Kot, cats: list[uuid.UUID | None]) -> list[dict]:
    wanted = set(printer.kot_category_ids or [])
    return [ln for ln, c in zip(kot.payload, cats) if not wanted or c in wanted]


def auto_print_kot(restaurant_id: uuid.UUID, kot_id: uuid.UUID, created_by: uuid.UUID | None = None) -> None:
    """Enqueue the KOT on every active printer with auto_kot, each with only its categories' lines. NEVER raises."""
    try:
        with tenant_session(restaurant_id) as db:
            kot = db.get(Kot, kot_id)
            if not kot:
                return
            printers = db.scalars(select(Printer).where(Printer.restaurant_id == restaurant_id, Printer.outlet_id == kot.outlet_id,
                                                        Printer.is_active.is_(True), Printer.auto_kot.is_(True))
                                  .order_by(Printer.created_at)).all()
            if not printers:
                return
            cats = _line_categories(db, kot)
            for pr in printers:
                try:
                    lines = kot_lines_for(pr, kot, cats)
                    if not lines or _job_exists(db, pr, "kot", kot.id):
                        continue
                    payload = escpos.render_kot(db, kot, lines, **_opts(pr))
                    _enqueue_copies(db, pr, "kot", kot.id, payload, 0, created_by)
                    _hold_if_old_offline(db, pr, "kot", kot.id)
                    db.commit()
                except Exception:
                    db.rollback()
                    log.exception("auto-print of KOT %s on printer %s failed", kot_id, pr.id)
    except Exception:
        log.exception("auto-print of KOT %s failed", kot_id)


def reprint_kot(db: Session, p, kot_id: uuid.UUID, printer_id: uuid.UUID | None) -> list[PrintJob]:
    kot = db.get(Kot, kot_id)
    if not kot or kot.restaurant_id != p.restaurant_id or not outlets.visible(p, kot):
        raise HTTPException(404, "KOT not found")
    cats = _line_categories(db, kot)
    if printer_id:
        targets = [get_printer(db, p, printer_id)]
    else:  # the kitchen printers that print KOTs automatically; else the first kitchen printer (all lines)
        active = select(Printer).where(Printer.restaurant_id == p.restaurant_id, Printer.outlet_id == kot.outlet_id,
                                       Printer.is_active.is_(True)).order_by(Printer.created_at)
        targets = list(db.scalars(active.where(Printer.auto_kot.is_(True))))
        if not targets:
            first = db.scalar(active.where(Printer.role == "kitchen").limit(1))
            targets = [first] if first else []
        if not targets:
            raise HTTPException(409, "No kitchen printer is set up")
    ids: list[uuid.UUID] = []
    for pr in targets:
        if not pr.is_active:
            raise HTTPException(409, "Printer is switched off")
        lines = kot_lines_for(pr, kot, cats)
        if not lines:
            if printer_id:
                raise HTTPException(409, "None of this KOT's items belong to that printer")
            continue
        ids += _reprint(db, p, pr, "kot", kot.id, lambda pr=pr, lines=lines: escpos.render_kot(db, kot, lines, reprint=True, **_opts(pr)))
    if not ids:
        raise HTTPException(409, "None of this KOT's items belong to a kitchen printer")
    audit.record(db, p, "kot.print", "kot", kot.id, {"number": kot.number})
    db.commit()
    return _jobs(db, ids)
