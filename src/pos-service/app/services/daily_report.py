"""End of day report email (docs/EMAIL.md).

When: at the restaurant's `daily_report_time` (default 23:00) in each OUTLET's local time zone, found by a background sweep
(DAILY_REPORT_SWEEP_SECONDS, default 300; 0 = off), and right after a Z report is closed (`daily_report_on_close`). The
ledger `daily_report_emails` has ONE row per (outlet, business date): whichever trigger comes first sends, the other finds
the row and does nothing, so the owner gets exactly one email per outlet and day (idempotent across workers and restarts).
A Z closed before 04:00 local time counts for the previous business day. A scheduled day with no activity at all is
recorded as `skipped` (no email). After a downtime the sweep catches up on yesterday until 06:00 local time.

Who: every active owner, plus active users who opted in (`users.daily_report_opt_in`). Each recipient gets their own message
(the mail policy applies per address: docs/EMAIL.md). Off switch: `restaurants.daily_report_email`.

What: the calendar day of the outlet (00:00 to 24:00 local, up to now): total sales (total takings, INR with lakh/crore
grouping), bills, average bill, payment split (cash / card / UPI / other), tax collected, top 5 items, voids, cash drawer
variance (cash sessions closed that day), low-stock items (tenant-wide, open alerts), with the 80 mm report PDF attached
(the Z report itself when a Z triggered it, else an X report of the day)."""
import logging
import threading
import time as _time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import event, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import tenant_session
from app.models.core import Alert, CashSession, Outlet, Restaurant, Role, User, ZReport
from app.models.mail import DailyReportEmail
from app.services import email_brand as B, mail, money, reports, zreport

log = logging.getLogger("app.daily_report")

Z_DAY_SHIFT = timedelta(hours=4)  # a Z closed before 04:00 belongs to the previous business day
CATCH_UP_UNTIL = time(6, 0)
MAX_ATTEMPTS = 3
STALE = timedelta(minutes=10)
SESSION_KEY = "daily_report_pending"
ZERO = Decimal("0.00")


def now() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(v: str | None) -> time:
    try:
        h, m = (v or "23:00").split(":")
        return time(int(h), int(m))
    except (ValueError, TypeError):
        return time(23, 0)


def day_window(tz: str, d: date, until: datetime | None = None) -> tuple[datetime, datetime]:
    z = ZoneInfo(tz)
    start = datetime.combine(d, time.min, tzinfo=z).astimezone(timezone.utc)
    end = datetime.combine(d + timedelta(days=1), time.min, tzinfo=z).astimezone(timezone.utc)
    if until is not None:
        end = max(start, min(end, until))
    return start, end


def z_business_date(z_end: datetime, tz: str) -> date:
    return (z_end.astimezone(ZoneInfo(tz)) - Z_DAY_SHIFT).date()


# ---------------------------------------------------------------- figures
def inr(x, currency: str = "INR") -> str:
    return money.fmt_inr(Decimal(str(x or 0)))  # INR only (docs/INR_ONLY.md)


def build(db: Session, rid: uuid.UUID, outlet: Outlet, d: date) -> dict:
    """The day's figures for one outlet (Decimals). Read-only."""
    r = db.get(Restaurant, rid)
    start, end = day_window(outlet.timezone or r.timezone, d, until=now())
    rep = zreport.compute(db, rid, start, end, "X", outlet.id)
    ded, summ = rep["deductions"], rep["summary"]
    bills = int(rep["grand_total"]["orders"])
    total = Decimal(ded["billed_total"])  # total_sales = what was billed (the figure the daily email always showed); total_takings is money received
    pay = {p["method"]: Decimal(p["amount"]) for p in summ["payments"]}
    vat = summ["vat"]
    tax = Decimal(vat["total"]["vat"]) if vat.get("shown") and vat.get("total") else ZERO
    items = reports.item_sales(reports.Ctx(db, rid, [outlet.id]), d, d, limit=5)["items"]
    sessions = db.execute(select(func.count(CashSession.id), func.coalesce(func.sum(CashSession.variance), 0)).where(
        CashSession.restaurant_id == rid, CashSession.outlet_id == outlet.id, CashSession.status == "closed",
        CashSession.closed_at >= start, CashSession.closed_at < end)).one()
    low = db.scalar(select(func.count(Alert.id)).where(Alert.restaurant_id == rid, Alert.kind == "low_stock",
                                                         Alert.status == "open")) or 0
    rep.update(number=None, number_label=None, id=None, closed_by=None, generated_at=end)
    return {
        "restaurant": r.name, "currency": r.currency, "tax_word": money.tax_word(r.tax_mode),
        "outlet": outlet.name, "date": d, "from": start, "to": end, "empty": bool(rep["empty"]),
        "total_sales": total, "bills": bills, "average_bill": (total / bills).quantize(Decimal("0.01")) if bills else ZERO,
        "net_sales": Decimal(ded["net_sales"]),
        "payments": {"cash": pay.get("cash", ZERO), "card": pay.get("card", ZERO), "upi": pay.get("upi", ZERO),
                     "other": pay.get("other", ZERO)},
        "tax": tax,
        "top_items": [{"item": i["item"], "quantity": i["quantity"], "revenue": Decimal(i["revenue_excl_vat"])} for i in items],
        "voids": {"count": int(rep["voids"]["count"]) + int(ded["bill_voids"]["count"]),
                  "amount": Decimal(rep["voids"]["amount"]) + Decimal(ded["bill_voids"]["amount"])},
        "cash_sessions": int(sessions[0]), "cash_variance": Decimal(sessions[1]).quantize(Decimal("0.01")),
        "low_stock": int(low), "report": rep,
    }


def render(s: dict, trigger: str = "schedule") -> tuple[str, str, str]:
    """(subject, text, html). English only, INR."""
    cur = s["currency"]
    day = s["date"].strftime("%d %b %Y")
    subject = f"End of day report - {s['outlet']} - {day} - {inr(s['total_sales'], cur)} sales"
    title = "End of day report"
    rows = [("Date", s["date"].strftime("%a, %d %b %Y")), ("Restaurant", s["restaurant"]), ("Outlet", s["outlet"]),
            ("Total sales", inr(s["total_sales"], cur)), ("Bills", str(s["bills"])),
            ("Average bill", inr(s["average_bill"], cur)),
            (f"{s['tax_word']} collected", inr(s["tax"], cur))]
    p = s["payments"]
    pay_rows = [("Cash", inr(p["cash"], cur)), ("Card", inr(p["card"], cur)), ("UPI", inr(p["upi"], cur))]
    if p["other"]:
        pay_rows.append(("Other", inr(p["other"], cur)))
    var = s["cash_variance"]
    var_txt = (f"{'+' if var > 0 else ''}{inr(var, cur)} over {s['cash_sessions']} closed session(s)"
               if s["cash_sessions"] else "No cash session closed")
    ctrl_rows = [("Voids", f"{s['voids']['count']} ({inr(s['voids']['amount'], cur)})"), ("Cash drawer variance", var_txt),
                 ("Low-stock items", str(s["low_stock"]))]
    top = [[str(i + 1) + ". " + t["item"], str(t["quantity"]), inr(t["revenue"], cur)] for i, t in enumerate(s["top_items"])]
    when = "the Z report was closed" if trigger == "z_close" else "the end of the day"
    body = (B.p(f"Here is the summary of {s['outlet']} for {day}, sent at {when}.")
            + B.table(rows, "Sales") + B.table(pay_rows, "Payment split") + B.table(ctrl_rows, "Controls")
            + (B.grid(["Top items", "Qty", "Revenue"], top, "Top 5 items") if top else B.p("No items sold.", muted=True)))
    note = (f"Amounts in INR. Total sales = total takings incl. {s['tax_word']}; top items are net of {s['tax_word']} and bill discounts. "
            "The report PDF is attached. Change who gets this email in Manage > Restaurant.")
    lines = [f"End of day report - {s['restaurant']} / {s['outlet']} - {day}", ""]
    lines += [f"{k}: {v}" for k, v in rows] + ["", "Payment split:"] + [f"  {k}: {v}" for k, v in pay_rows]
    lines += [""] + [f"{k}: {v}" for k, v in ctrl_rows] + ["", "Top 5 items:"]
    lines += [f"  {a}  x{b}  {c}" for a, b, c in top] or ["  (none)"]
    lines += ["", note, "", B.TEXT_FOOTER]
    return subject, "\n".join(lines) + "\n", B.layout(title, body, preheader=subject, footer_note=note)


def pdf(s: dict, z: ZReport | None) -> tuple[str, bytes] | None:
    if not settings.daily_report_attach_pdf:
        return None
    try:
        if z is not None:
            return f"Z-report-{z.data.get('number_label') or z.number}-{s['date'].isoformat()}.pdf", zreport.render_pdf(z.data, None)
        return f"day-report-{s['date'].isoformat()}.pdf", zreport.render_pdf(reports.to_json(s["report"]), None)
    except Exception:  # noqa: BLE001 - the email goes out without the attachment
        log.exception("daily report PDF could not be rendered")
        return None


def recipients(db: Session, rid: uuid.UUID) -> list[tuple[str, str]]:
    rows = db.execute(select(User.email, User.full_name).where(
        User.restaurant_id == rid, User.is_active, (User.role == Role.owner) | User.daily_report_opt_in)
        .order_by(User.created_at)).all()
    seen, out = set(), []
    for e, n in rows:
        if e and e.lower() not in seen and mail.valid_email(e):
            seen.add(e.lower())
            out.append((e, n))
    return out[:20]


# ---------------------------------------------------------------- ledger + delivery
def claim(db: Session, rid: uuid.UUID, oid: uuid.UUID, d: date, trigger: str, z_id: uuid.UUID | None = None) -> uuid.UUID | None:
    """Inserts the (outlet, date) row; None when it already exists (another trigger / worker got there first)."""
    rid_new = uuid.uuid4()
    res = db.execute(insert(DailyReportEmail).values(
        id=rid_new, restaurant_id=rid, outlet_id=oid, business_date=d, trigger=trigger, status="queued", z_report_id=z_id)
        .on_conflict_do_nothing(constraint="uq_daily_report_emails_outlet_date").returning(DailyReportEmail.id))
    got = res.scalar()
    db.commit()
    return got


def deliver(tenant_id: uuid.UUID, row_id: uuid.UUID) -> str | None:
    """Builds and sends one ledger row. Returns the final status (None when another worker holds it). Never raises."""
    try:
        with tenant_session(tenant_id) as db:
            row = db.scalar(select(DailyReportEmail).where(DailyReportEmail.id == row_id, DailyReportEmail.status == "queued")
                            .with_for_update(skip_locked=True))
            if row is None:
                return None
            r = db.get(Restaurant, tenant_id)
            outlet = db.get(Outlet, row.outlet_id)
            row.attempts += 1
            if r is None or outlet is None or not r.daily_report_email:
                row.status, row.error = "skipped", "switched off"
                db.commit()
                return row.status
            s = build(db, tenant_id, outlet, row.business_date)
            if s["empty"] and row.trigger == "schedule":
                row.status, row.error = "skipped", "no activity"
                db.commit()
                return row.status
            to = recipients(db, tenant_id)
            if not to:
                row.status, row.error = "skipped", "no recipients"
                db.commit()
                return row.status
            z = db.get(ZReport, row.z_report_id) if row.z_report_id else None
            subject, text_, html_ = render(s, row.trigger)
            att = pdf(s, z)
            ok, err = 0, None
            for email, _name in to:
                try:
                    mail.send(mail.build(email, subject, text_, html_, from_name="TheChilli.ai",
                                         attachments=[(att[0], "application/pdf", att[1])] if att else None))
                    ok += 1
                except Exception as e:  # noqa: BLE001
                    err = mail.safe_error(e)
                    log.warning("daily report to %s failed: %s", mail.redact(email), err)
            row.recipients = ok
            if ok:
                row.status, row.error, row.sent_at = "sent", (f"{len(to) - ok} recipient(s) failed: {err}"[:300] if err else None), now()
            else:
                row.error = (err or "not sent")[:300]
                row.status = "failed" if row.attempts >= MAX_ATTEMPTS else "queued"  # queued: the sweep retries it later
            db.commit()
            return row.status
    except Exception:  # noqa: BLE001
        log.exception("daily report %s: delivery crashed", row_id)
        return None


def run_tenant(tenant_id: uuid.UUID, at: datetime | None = None) -> list[uuid.UUID]:
    """Claims and sends every due (outlet, date) of one tenant. Returns the delivered row ids."""
    at = at or now()
    due: list[uuid.UUID] = []
    with tenant_session(tenant_id) as db:
        r = db.get(Restaurant, tenant_id)
        if r is None or not r.daily_report_email:
            return []
        send_at = parse_time(r.daily_report_time)
        outlets_ = db.scalars(select(Outlet).where(Outlet.restaurant_id == tenant_id, Outlet.is_active)).all()
        stale = db.scalars(select(DailyReportEmail.id).where(
            DailyReportEmail.restaurant_id == tenant_id, DailyReportEmail.status == "queued",
            DailyReportEmail.updated_at < at - STALE)).all()
        db.rollback()
        due.extend(stale)
        for o in outlets_:
            local = at.astimezone(ZoneInfo(o.timezone or r.timezone))
            days = []
            if local.time() >= send_at:
                days.append(local.date())
            elif local.time() < CATCH_UP_UNTIL:
                days.append(local.date() - timedelta(days=1))
            for d in days:
                if o.created_at and o.created_at.astimezone(local.tzinfo).date() > d:
                    continue  # the outlet did not exist that day
                got = claim(db, tenant_id, o.id, d, "schedule")
                if got:
                    due.append(got)
    for row_id in due:
        deliver(tenant_id, row_id)
    return due


def sweep(at: datetime | None = None) -> None:
    if mail.get_provider() is None:
        return
    with SessionLocal() as db:
        ids = [x.tenant_id for x in db.execute(text("SELECT tenant_id FROM daily_report_tenants()")).all()]
        db.commit()
    try:
        from app.services import otp
        with SessionLocal() as db:  # housekeeping: dead one-time codes (and pending sign-up data) older than two days
            otp.purge(db)
            db.commit()
    except Exception:  # noqa: BLE001
        log.exception("one-time code purge failed")
    for tid in ids:
        try:
            run_tenant(tid, at)
        except Exception:  # noqa: BLE001 - one tenant's problem must not stop the others
            log.exception("daily report sweep failed for a tenant")


_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="daily-report")


def _safe(fn, *args) -> None:
    try:
        fn(*args)
    except Exception:  # noqa: BLE001
        log.exception("daily report background job failed")


def submit(fn, *args) -> None:
    """Runs fn(*args) off the request thread. Tests replace this to run jobs inline."""
    _pool.submit(_safe, fn, *args)


def start_sweeper() -> None:
    every = settings.daily_report_sweep_seconds
    if every <= 0:
        return

    def loop() -> None:
        while True:
            _time.sleep(every)
            _safe(sweep)

    threading.Thread(target=loop, name="daily-report-sweep", daemon=True).start()


# ---------------------------------------------------------------- Z close trigger (after commit, like re-order emails)
def note_z_close(db: Session, z: ZReport) -> None:
    """Called inside the Z close transaction; the email is claimed and sent only after it commits."""
    db.info.setdefault(SESSION_KEY, []).append((z.restaurant_id, z.outlet_id, z.id, z.period_to))


def _z_job(rid: uuid.UUID, oid: uuid.UUID, zid: uuid.UUID, period_to: datetime) -> None:
    with tenant_session(rid) as db:
        r = db.get(Restaurant, rid)
        o = db.get(Outlet, oid)
        if not r or not o or not r.daily_report_email or not r.daily_report_on_close:
            return
        d = z_business_date(period_to, o.timezone or r.timezone)
        got = claim(db, rid, oid, d, "z_close", zid)
    if got:
        deliver(rid, got)


def _after_commit(session: Session) -> None:
    jobs = session.info.pop(SESSION_KEY, None)
    for j in jobs or ():
        try:
            submit(_z_job, *j)
        except Exception:  # noqa: BLE001 - the Z is already committed
            log.exception("could not schedule the daily report email")


def _after_rollback(session: Session) -> None:
    session.info.pop(SESSION_KEY, None)


event.listen(SessionLocal, "after_commit", _after_commit)
event.listen(SessionLocal, "after_rollback", _after_rollback)


# ---------------------------------------------------------------- owner actions (API)
def send_now(db: Session, p, outlet_id: uuid.UUID | None, d: date | None, resend: bool = False) -> DailyReportEmail:
    """Owner's 'send now' for one outlet and day (default: the principal's outlet, today local). Same ledger: an already sent
    day is returned as is unless resend=True (then the row is re-queued and sent again)."""
    o = db.get(Outlet, outlet_id or p.outlet_id) if (outlet_id or getattr(p, "outlet_id", None)) else None
    if o is None:
        o = db.scalar(select(Outlet).where(Outlet.restaurant_id == p.restaurant_id, Outlet.is_default))
    if o is None or o.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Outlet not found")
    r = db.get(Restaurant, p.restaurant_id)
    d = d or now().astimezone(ZoneInfo(o.timezone or r.timezone)).date()
    if mail.get_provider() is None:
        raise HTTPException(409, "Email is not set up on this server")
    if not r.daily_report_email:
        raise HTTPException(409, "The daily report email is switched off for this restaurant")
    got = claim(db, p.restaurant_id, o.id, d, "manual")
    row = db.scalar(select(DailyReportEmail).where(DailyReportEmail.outlet_id == o.id, DailyReportEmail.business_date == d))
    if got is None and resend and row.status in ("sent", "skipped", "failed"):
        row.status, row.trigger, row.attempts, row.error = "queued", "manual", 0, None
        db.commit()
        got = row.id
    if got is not None:
        deliver(p.restaurant_id, got)
    db.expire_all()
    return db.scalar(select(DailyReportEmail).where(DailyReportEmail.outlet_id == o.id, DailyReportEmail.business_date == d))
