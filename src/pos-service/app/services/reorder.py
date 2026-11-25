"""Supplier re-order emails: composing, sending (SMTP from the environment), the log, and the automatic low-stock trigger.

Flow of an AUTOMATIC email (never on the billing path):
  1. alerts.evaluate opens a low-stock alert for an item that has a usual supplier and flags it `email_pending`; it also notes
     the restaurant in `session.info`. After the surrounding COMMIT (a SQLAlchemy `after_commit` hook, so every caller of
     evaluate is covered) a background thread runs `run_auto(restaurant_id)`. A failure there is logged, never raised.
  2. run_auto groups the pending alerts by supplier. Per supplier, under a Postgres advisory lock (so several API workers
     cannot both decide), it checks the window (at most one automatic email per supplier per N hours), re-reads the pending
     alerts, writes ONE `supplier_emails` row (status queued) for all of them and marks the alerts as covered. Items that
     became low inside the window stay pending and go out with the next window (a periodic sweep also picks them up).
  3. `deliver` sends a queued email with up to 3 attempts and a backoff; the outcome (sent / failed + error) is stored.
     The row stays locked (FOR UPDATE SKIP LOCKED) while it is being sent, so a worker that sees the same row skips it.
A MANUAL email (Manage > Inventory / Suppliers) goes through the same compose / deliver code with kind = manual.

Secrets: the SMTP password only ever lives in `settings.smtp_password` (a SecretStr); it is read in `_smtp_send` and nowhere
else, and no log line, error text or endpoint includes it."""
import hashlib
import html
import json
import logging
import os
import re
import smtplib
import ssl
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import ROUND_CEILING, Decimal
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, parseaddr
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import event, func, select, text, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import tenant_session
from app.models.core import Alert, InventoryItem, Restaurant, Supplier, SupplierEmail
from app.services import audit, mail

log = logging.getLogger("app.reorder")

SESSION_KEY = "reorder_restaurants"
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (2.0, 10.0)  # wait before attempt 2 and 3 (tests set this to zeros)
STALE_QUEUED = timedelta(minutes=5)  # a queued email nobody is sending (process died) is picked up by the sweep
MAX_ITEMS = 60
MAX_QTY = Decimal("99999999")
EMAIL_RE = re.compile(r"^[^@\s<>,;\"']+@[^@\s<>,;\"']+\.[^@\s<>,;\"']+$")
_CTRL = re.compile(r"[\x00-\x1f\x7f  ]+")
NOT_SET_UP = "Email is not set up"


# ---------------------------------------------------------------- configuration
def from_address() -> str:
    return mail.from_address()


def configured() -> bool:
    """True when emails can be sent (SMTP host + sender mailbox from the environment) or the test sink is on."""
    return mail.configured()


# ---------------------------------------------------------------- text helpers
def _clean(v: str | None, limit: int = 300) -> str:
    return mail.clean(v, limit)


def valid_email(v: str) -> bool:
    return mail.valid_email(v)


def _num(q: Decimal) -> str:
    q = q.quantize(Decimal("0.01")).normalize()
    return format(q, "f")


def fmt_qty(value, unit: str) -> str:
    """1500 g -> '1.5 kg', 12 pcs -> '12 pcs' (display only; the stored value stays in the base unit)."""
    q = Decimal(str(value))
    if unit == "g" and abs(q) >= 1000:
        q, unit = q / 1000, "kg"
    elif unit == "ml" and abs(q) >= 1000:
        q, unit = q / 1000, "l"
    return f"{_num(q)} {unit}"


def _round_up(raw: Decimal, unit: str) -> Decimal:
    if unit == "pcs":
        step = Decimal(1) if raw < 20 else Decimal(5) if raw < 100 else Decimal(10)
    else:
        step = Decimal(1000) if raw >= 5000 else Decimal(500) if raw >= 1000 else Decimal(100) if raw >= 200 \
            else Decimal(50) if raw >= 50 else Decimal(10)
    return (raw / step).to_integral_value(rounding=ROUND_CEILING) * step


def suggest_quantity(item: InventoryItem, balance: Decimal) -> Decimal:
    """What to ask for: the item's own re-order quantity, else max(2 x reorder level - balance, reorder level) rounded UP to a
    round number of the unit (10 g steps ... 1 kg steps; whole pieces). Never zero."""
    if item.reorder_quantity is not None and item.reorder_quantity > 0:
        return item.reorder_quantity
    lvl = item.reorder_level or Decimal(0)
    raw = max(lvl * 2 - max(balance, Decimal(0)), lvl)
    if raw <= 0:
        raw = Decimal(10) if item.base_unit == "pcs" else Decimal(1000)
    return _round_up(raw, item.base_unit)


# ---------------------------------------------------------------- composing
def line_item(item: InventoryItem, balance: Decimal, quantity: Decimal) -> dict:
    return {"item_id": str(item.id), "name": _clean(item.name, 200), "unit": item.base_unit,
            "balance": str(balance), "quantity": str(quantity)}


def compose(restaurant: Restaurant, supplier: Supplier, items: list[dict], note: str | None = None) -> tuple[str, str, str]:
    """-> (subject, plain text, html). English, short, polite; no prices and no internal ids. Every user-supplied string is
    escaped in the HTML and single-lined in the subject."""
    rname = _clean(restaurant.name, 120) or "Our restaurant"
    greet = _clean(supplier.contact_name, 120) or _clean(supplier.name, 200)
    n = len(items)
    subject = _clean(f"Re-order request - {rname} - {n} item{'' if n == 1 else 's'}")
    note = " ".join((note or "").split())[:500] or None
    addr = [ln.strip() for ln in (restaurant.address or "").replace("\r", "").split("\n") if ln.strip()]
    phone = _clean(restaurant.phone, 40)
    lines = [f"- {i['name']}: current stock {fmt_qty(i['balance'], i['unit'])}, please send {fmt_qty(i['quantity'], i['unit'])}"
             for i in items]
    text = "\n".join([
        f"Hello {greet},", "", "We would like to re-order the following:", "", *lines, "",
        *([f"Note: {note}", ""] if note else []),
        "Please confirm availability and delivery date.", "",
        "Thank you,", rname, *[_clean(a, 200) for a in addr], *([f"Phone: {phone}"] if phone else []),
    ]) + "\n"
    esc = html.escape
    rows = "".join(
        f'<tr><td style="padding:4px 12px 4px 0">{esc(i["name"])}</td>'
        f'<td style="padding:4px 12px 4px 0">{esc(fmt_qty(i["balance"], i["unit"]))}</td>'
        f'<td style="padding:4px 0"><b>{esc(fmt_qty(i["quantity"], i["unit"]))}</b></td></tr>' for i in items)
    sig = "<br>".join([f"<b>{esc(rname)}</b>", *[esc(_clean(a, 200)) for a in addr], *([f"Phone: {esc(phone)}"] if phone else [])])
    body_html = (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">'
        f"<p>Hello {esc(greet)},</p><p>We would like to re-order the following:</p>"
        '<table style="border-collapse:collapse"><thead><tr>'
        '<th align="left" style="padding:4px 12px 4px 0">Item</th><th align="left" style="padding:4px 12px 4px 0">Current stock</th>'
        f'<th align="left" style="padding:4px 0">Quantity needed</th></tr></thead><tbody>{rows}</tbody></table>'
        + (f"<p>Note: {esc(note)}</p>" if note else "")
        + f"<p>Please confirm availability and delivery date.</p><p>Thank you,<br>{sig}</p></div>")
    return subject, text, body_html


def build_message(row: SupplierEmail, restaurant: Restaurant) -> EmailMessage:
    sender = from_address() or "noreply@localhost"
    to = _clean(row.to_email, 254)
    if not valid_email(to):
        raise ValueError("The supplier's email address is not valid")
    msg = EmailMessage()
    msg["From"] = formataddr((_clean(restaurant.name, 120), sender))
    msg["To"] = to
    msg["Reply-To"] = sender
    msg["Subject"] = _clean(row.subject)
    msg["Message-ID"] = make_msgid(domain=sender.rpartition("@")[2] or "localhost")
    msg.set_content(row.body_text)
    if row.body_html:
        msg.add_alternative(row.body_html, subtype="html")
    return msg


# ---------------------------------------------------------------- transport (the one place that talks to a mail server)
def _smtp_send(msg: EmailMessage) -> None:
    mail.SmtpProvider().send(msg)


def send_message(msg: EmailMessage) -> None:
    """Sends one message through the mail provider (app/services/mail.py). Raises on any failure. Tests replace this function."""
    mail.send(msg)


def _error_text(e: Exception) -> str:
    return mail.safe_error(e)


# ---------------------------------------------------------------- delivery with retries
def deliver(tenant_id: uuid.UUID, email_id: uuid.UUID) -> None:
    """Sends one queued email of this tenant: up to MAX_ATTEMPTS tries with a growing pause; stores sent / failed. Never raises."""
    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            with tenant_session(tenant_id) as db:
                row = db.scalar(select(SupplierEmail).where(SupplierEmail.id == email_id, SupplierEmail.restaurant_id == tenant_id,
                                                            SupplierEmail.status == "queued")
                                .with_for_update(skip_locked=True))
                if row is None:
                    return  # already sent / failed, or another worker is sending it right now
                if not configured():
                    row.status, row.error = "failed", NOT_SET_UP
                    db.commit()
                    return
                restaurant = db.get(Restaurant, row.restaurant_id)
                row.attempts += 1
                try:
                    send_message(build_message(row, restaurant))
                except Exception as e:  # noqa: BLE001 - any transport / validation problem is recorded, never raised
                    row.error = _error_text(e)
                    if attempt >= MAX_ATTEMPTS:
                        row.status = "failed"
                    db.commit()
                    if row.status == "failed":
                        log.warning("re-order email %s failed after %d attempts: %s", email_id, attempt, row.error)
                        return
                else:
                    row.status, row.error, row.sent_at = "sent", None, datetime.now(timezone.utc)
                    db.commit()
                    return
            time.sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
    except Exception:  # noqa: BLE001
        log.exception("re-order email %s: delivery crashed", email_id)


# ---------------------------------------------------------------- background plumbing
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="reorder")


def _safe(fn, *args) -> None:
    try:
        fn(*args)
    except Exception:  # noqa: BLE001
        log.exception("re-order background job failed")


def submit(fn, *args) -> None:
    """Runs fn(*args) off the request thread. Tests replace this to run jobs inline or to collect them."""
    _pool.submit(_safe, fn, *args)


def schedule(restaurant_ids) -> None:
    for rid in restaurant_ids:
        submit(run_auto, rid)


def _after_commit(session: Session) -> None:
    ids = session.info.pop(SESSION_KEY, None)
    if ids:
        try:
            schedule(ids)
        except Exception:  # noqa: BLE001 - the sale is already committed; nothing here may fail it
            log.exception("could not schedule re-order emails")


def _after_rollback(session: Session) -> None:
    session.info.pop(SESSION_KEY, None)


event.listen(SessionLocal, "after_commit", _after_commit)
event.listen(SessionLocal, "after_rollback", _after_rollback)


def wants_auto(restaurant: Restaurant | None, item: InventoryItem) -> bool:
    """Should a NEW low-stock alert of this item be emailed? (Re-checked when the email is built.)"""
    return bool(restaurant and restaurant.auto_reorder_emails and item.supplier_id and configured())


def note_pending(db: Session, restaurant_id: uuid.UUID) -> None:
    db.info.setdefault(SESSION_KEY, set()).add(restaurant_id)


# ---------------------------------------------------------------- automatic emails
def _pending_alerts(db: Session, supplier_id: uuid.UUID, lock: bool = False) -> list[tuple[Alert, InventoryItem]]:
    q = (select(Alert, InventoryItem).join(InventoryItem, InventoryItem.id == Alert.item_id)
         .where(InventoryItem.supplier_id == supplier_id, InventoryItem.is_active, Alert.kind == "low_stock",
                Alert.status == "open", Alert.email_pending, Alert.supplier_email_id.is_(None))
         .order_by(InventoryItem.name, Alert.id))
    if lock:
        q = q.with_for_update(of=Alert).execution_options(populate_existing=True)
    return [(a, i) for a, i in db.execute(q)]


def _claim_supplier(db: Session, restaurant: Restaurant, supplier_id: uuid.UUID) -> uuid.UUID | None:
    """One automatic email for everything of this supplier that is pending now, or None (window not over / nothing to send)."""
    from app.services import inventory  # local import: inventory -> alerts -> reorder
    db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(f"reorder:{supplier_id}", 0))))
    sup = db.get(Supplier, supplier_id, populate_existing=True)
    if (not sup or sup.restaurant_id != restaurant.id or not sup.is_active or not sup.auto_reorder
            or not sup.email or not valid_email(sup.email)):
        db.rollback()
        return None
    since = datetime.now(timezone.utc) - timedelta(hours=restaurant.reorder_email_window_hours)
    if db.scalar(select(SupplierEmail.id).where(
            SupplierEmail.supplier_id == sup.id, SupplierEmail.kind == "auto", SupplierEmail.status != "failed",
            SupplierEmail.created_at > since).limit(1)):
        db.rollback()  # inside this supplier's window: the pending items wait for the next one
        return None
    pending = _pending_alerts(db, sup.id, lock=True)
    bal = inventory.balances(db, restaurant.id, [i.id for _, i in pending])
    low = [(a, i) for a, i in pending if bal.get(i.id, Decimal(0)) <= i.reorder_level]
    for a, i in pending:
        if (a, i) not in low:
            a.email_pending = False  # stock recovered meanwhile; evaluate() resolves the alert itself
    low = low[:MAX_ITEMS]
    if not low:
        db.commit()
        return None
    items = [line_item(i, bal.get(i.id, Decimal(0)), suggest_quantity(i, bal.get(i.id, Decimal(0)))) for _, i in low]
    subject, text, body_html = compose(restaurant, sup, items)
    key = "auto:%s:%s" % (sup.id, hashlib.sha1(",".join(sorted(str(a.id) for a, _ in low)).encode()).hexdigest())
    row = SupplierEmail(restaurant_id=restaurant.id, supplier_id=sup.id, to_email=sup.email, subject=subject, body_text=text,
                        body_html=body_html, items=items, kind="auto", status="queued", dedupe_key=key)
    db.add(row)
    db.flush()
    for a, _ in low:
        a.supplier_email_id, a.email_pending = row.id, False
    audit.record(db, SimpleNamespace(restaurant_id=restaurant.id, user_id=None), "supplier_email.auto", "supplier_email",
                 row.id, {"supplier": sup.name, "items": len(items)})
    db.commit()
    return row.id


def run_auto(restaurant_id: uuid.UUID) -> list[uuid.UUID]:
    """Background job: emails every supplier that has pending low items and is outside its window. Returns the email ids."""
    if not configured():
        return []
    sent: list[uuid.UUID] = []
    with tenant_session(restaurant_id) as db:
        restaurant = db.get(Restaurant, restaurant_id)
        if not restaurant or not restaurant.auto_reorder_emails:
            return []
        sids = db.scalars(select(InventoryItem.supplier_id).join(Alert, Alert.item_id == InventoryItem.id).where(
            Alert.restaurant_id == restaurant_id, Alert.kind == "low_stock", Alert.status == "open", Alert.email_pending,
            Alert.supplier_email_id.is_(None), InventoryItem.supplier_id.is_not(None)).distinct()).all()
        db.rollback()
        for sid in sids:
            try:
                eid = _claim_supplier(db, restaurant, sid)
            except Exception:  # noqa: BLE001 - one supplier's problem must not stop the others
                db.rollback()
                log.exception("re-order email for supplier %s could not be prepared", sid)
                continue
            if eid:
                sent.append(eid)
    for eid in sent:
        deliver(restaurant_id, eid)
    return sent


def sweep() -> None:
    """Periodic safety net: (1) pending low items whose window has opened, (2) queued emails whose sender died."""
    if not configured():
        return
    # Cross-tenant by design: one SECURITY DEFINER call (app/core/definer.py) finds the tenants with pending low items and
    # claims the stale queued emails; the work itself then runs in per-tenant sessions.
    with SessionLocal() as db:
        work = db.execute(text("SELECT tenant_id, kind, id FROM reorder_due_work(:before)"),
                          {"before": datetime.now(timezone.utc) - STALE_QUEUED}).all()
        db.commit()
    for w in work:
        if w.kind == "run_auto":
            run_auto(w.tenant_id)
    for w in work:
        if w.kind == "deliver":
            deliver(w.tenant_id, w.id)


def start_sweeper() -> None:
    every = settings.reorder_sweep_seconds
    if every <= 0:
        return

    def loop() -> None:
        while True:
            time.sleep(every)
            _safe(sweep)

    threading.Thread(target=loop, name="reorder-sweep", daemon=True).start()


# ---------------------------------------------------------------- manual emails
def parse_selection(db: Session, p, selection) -> list[dict]:
    """[(item_id, quantity, unit)] from the dialog -> validated line items (base units) with the current balance."""
    from fastapi import HTTPException

    from app.services import inventory
    from app.services.units import to_base
    if not selection:
        raise HTTPException(422, "Choose at least one item")
    if len(selection) > MAX_ITEMS:
        raise HTTPException(422, f"Too many items (up to {MAX_ITEMS} per email)")
    ids = [s.item_id for s in selection]
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "An item is listed twice")
    items = {i.id: i for i in db.scalars(select(InventoryItem).where(
        InventoryItem.restaurant_id == p.restaurant_id, InventoryItem.id.in_(ids)))}
    if len(items) != len(ids):
        raise HTTPException(404, "Inventory item not found")
    bal = inventory.balances(db, p.restaurant_id, ids)
    out = []
    for s in selection:
        it = items[s.item_id]
        q = to_base(s.quantity, s.unit, it.base_unit)
        if q <= 0 or q > MAX_QTY:
            raise HTTPException(422, f"Quantity for {it.name} must be above zero")
        out.append(line_item(it, bal.get(it.id, Decimal(0)), q))
    return out


def draft(db: Session, p, supplier: Supplier, selection, note: str | None) -> dict:
    items = parse_selection(db, p, selection)
    restaurant = db.get(Restaurant, p.restaurant_id)
    subject, text, body_html = compose(restaurant, supplier, items, note)
    reason = None
    if not configured():
        reason = NOT_SET_UP
    elif not supplier.email:
        reason = "This supplier has no email address yet"
    elif not valid_email(supplier.email):
        reason = "This supplier's email address is not valid"
    return {"to": supplier.email, "subject": subject, "body_text": text, "items": items, "can_send": reason is None, "reason": reason,
            "_html": body_html, "_note": note}


def queue_manual(db: Session, p, supplier: Supplier, selection, note: str | None) -> SupplierEmail:
    from fastapi import HTTPException
    d = draft(db, p, supplier, selection, note)
    if not d["can_send"]:
        raise HTTPException(409, d["reason"])
    row = SupplierEmail(restaurant_id=p.restaurant_id, supplier_id=supplier.id, to_email=supplier.email, subject=d["subject"],
                        body_text=d["body_text"], body_html=d["_html"], items=d["items"],
                        note=(" ".join((note or "").split())[:500] or None), kind="manual", status="queued", created_by=p.user_id)
    db.add(row)
    db.flush()
    # the owner has just asked for these: an automatic email must not repeat them while the shortage lasts
    db.execute(update(Alert).where(
        Alert.restaurant_id == p.restaurant_id, Alert.kind == "low_stock", Alert.status == "open",
        Alert.supplier_email_id.is_(None), Alert.item_id.in_([uuid.UUID(i["item_id"]) for i in d["items"]]))
        .values(supplier_email_id=row.id, email_pending=False))
    audit.record(db, p, "supplier_email.manual", "supplier_email", row.id, {"supplier": supplier.name, "items": len(d["items"])})
    db.commit()
    return row


def requeue(db: Session, p, email_id: uuid.UUID) -> SupplierEmail:
    from fastapi import HTTPException
    row = db.get(SupplierEmail, email_id, with_for_update=True)
    if not row or row.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Email not found")
    if row.status != "failed":
        raise HTTPException(409, "Only a failed email can be sent again")
    if not configured():
        raise HTTPException(409, NOT_SET_UP)
    sup = db.get(Supplier, row.supplier_id)
    old = row.to_email
    if sup and sup.email and valid_email(sup.email):
        row.to_email = sup.email  # the owner may have corrected a wrong address since
    row.status, row.error, row.attempts = "queued", None, 0
    audit.record(db, p, "supplier_email.resend", "supplier_email", row.id, {"to": {"old": old, "new": row.to_email}})
    db.commit()
    return row
