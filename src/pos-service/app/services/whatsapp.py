"""WhatsApp: sender interface, Meta Cloud API implementation, outbox with retry/backoff/dead state, runner, opt-out handling.

Two kinds of message, two methods (the 24-hour rule): `send_template` (an approved template; works any time, the only way to
START a conversation) and `send_text` (free text; only allowed while the customer's last inbound message is < 24 hours old,
which the service checks from `whatsapp_contacts.last_inbound_at` before it even queues one). The receipt link and the 'bill
ready' notification are business-initiated, so they are templates.

A provider failure NEVER fails the business operation: the caller only writes an outbox row (in its own transaction); the
runner (`deliver` right after the commit, `sweep` periodically) sends it with up to WHATSAPP_MAX_ATTEMPTS tries and a backoff;
a permanent error (HTTP 4xx other than 429) or the last failed try makes the row `dead` (visible, can be re-queued by an owner).

Secrets: the access token / app secret live in SecretStr settings, are read only where used, and never appear in logs, errors
or stored `last_error` text (`_safe_error`).

Opt-out: a customer who writes STOP (or 'बंद') to the platform number is opted out for every restaurant (`whatsapp_contacts`,
a global table: the webhook does not know a tenant); START undoes it. Checked when queueing AND again right before sending."""
import hashlib
import hmac
import json
import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

import httpx
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import tenant_session
from app.models.core import WhatsAppContact, WhatsAppOutbox
from app.services import comms_templates

log = logging.getLogger("app.whatsapp")

# Template names to register in Meta (docs/COMMS.md). Body variables are positional: {{1}}, {{2}}, ...
TEMPLATE_RECEIPT = "pos_receipt_link_v1"   # {{1}} customer name, {{2}} restaurant, {{3}} invoice no., {{4}} receipt link
TEMPLATE_BILL_READY = "pos_bill_ready_v1"  # {{1}} customer name, {{2}} restaurant, {{3}} invoice no., {{4}} total with currency
LANGUAGES = ("en", "hi")
WINDOW = timedelta(hours=24)
LEASE_SECONDS = 300  # a claimed row not finished within this long is picked up again


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- phone numbers
_NON_DIGIT = re.compile(r"[^\d+]")


def _in_mobile(n: str) -> bool:
    return len(n) == 10 and n[0] in "6789"


def normalize_phone(raw: str | None, region: str | None = None) -> str | None:
    """-> E.164 (`+919876543210`) or None. India first: 10-digit mobiles (6-9...), `0` / `91` / `+91` / `0091` prefixes. Other
    countries need their code (`+971...`, `00971...`, or digits that cannot be an Indian number). None = not a usable number."""
    s = _NON_DIGIT.sub("", (raw or "").strip())
    if not s:
        return None
    plus = s.startswith("+")
    s = s.replace("+", "")
    if not s.isdigit():
        return None
    if not plus and s.startswith("00"):
        plus, s = True, s[2:]
    if plus:
        if s.startswith("91"):
            return "+91" + s[2:] if _in_mobile(s[2:]) else None  # an Indian number is exactly 10 digits
        return "+" + s if 8 <= len(s) <= 15 and s[0] != "0" else None
    if (region or settings.whatsapp_default_region).upper() == "IN":
        if _in_mobile(s):
            return "+91" + s
        if len(s) == 11 and s[0] == "0" and _in_mobile(s[1:]):
            return "+91" + s[1:]
        if len(s) == 12 and s.startswith("91") and _in_mobile(s[2:]):
            return "+" + s
    if 11 <= len(s) <= 15 and s[0] != "0" and not s.startswith("91"):
        return "+" + s  # digits that start with a foreign country code
    return None


# ---------------------------------------------------------------- senders
class WhatsAppError(Exception):
    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


class WhatsAppSender(Protocol):
    def send_template(self, to: str, name: str, language: str, params: list[str]) -> str: ...
    def send_text(self, to: str, body: str) -> str: ...


def _safe_error(e: Exception) -> str:
    t = f"{type(e).__name__}: {e}"[:400]
    for secret in (settings.whatsapp_access_token.get_secret_value(), settings.whatsapp_app_secret.get_secret_value()):
        if secret:
            t = t.replace(secret, "***")
    return t[:500]


class MetaCloudSender:
    """Meta WhatsApp Cloud API (graph.facebook.com). `transport` lets tests inject httpx.MockTransport."""

    def __init__(self, transport: httpx.BaseTransport | None = None):
        self.transport = transport

    def _post(self, payload: dict) -> str:
        url = f"https://graph.facebook.com/{settings.whatsapp_api_version}/{settings.whatsapp_phone_number_id}/messages"
        headers = {"Authorization": f"Bearer {settings.whatsapp_access_token.get_secret_value()}"}
        try:
            with httpx.Client(timeout=settings.whatsapp_timeout, transport=self.transport) as c:
                r = c.post(url, json=payload, headers=headers)
        except httpx.HTTPError as e:  # network, timeout, TLS: worth retrying
            raise WhatsAppError(f"network error: {type(e).__name__}", retryable=True) from None
        if r.status_code >= 400:
            try:
                err = r.json().get("error", {})
            except Exception:  # noqa: BLE001
                err = {}
            code = err.get("code")
            msg = str(err.get("message") or "")[:200]
            retryable = r.status_code >= 500 or r.status_code == 429 or code in (4, 17, 80007, 130429, 131056)  # throttling
            raise WhatsAppError(f"HTTP {r.status_code} code {code}: {msg}", retryable=retryable)
        try:
            return str(r.json()["messages"][0]["id"])
        except Exception:  # noqa: BLE001
            raise WhatsAppError("unexpected response from WhatsApp", retryable=True) from None

    def send_template(self, to: str, name: str, language: str, params: list[str]) -> str:
        template: dict = {"name": name, "language": {"code": language}}
        if params:
            template["components"] = [{"type": "body", "parameters": [{"type": "text", "text": p} for p in params]}]
        return self._post({"messaging_product": "whatsapp", "to": to.lstrip("+"), "type": "template", "template": template})

    def send_text(self, to: str, body: str) -> str:
        return self._post({"messaging_product": "whatsapp", "to": to.lstrip("+"), "type": "text",
                           "text": {"body": body, "preview_url": False}})


class FileSender:
    """Development: writes every message as JSON into WHATSAPP_DEV_DIR instead of sending it."""

    def __init__(self, directory: str):
        self.directory = directory

    def _write(self, doc: dict) -> str:
        d = Path(self.directory)
        d.mkdir(parents=True, exist_ok=True)
        mid = f"dev.{uuid.uuid4()}"
        (d / f"{mid}.json").write_text(json.dumps(doc))
        return mid

    def send_template(self, to, name, language, params):
        return self._write({"to": to, "template": name, "language": language, "params": params})

    def send_text(self, to, body):
        return self._write({"to": to, "text": body})


class FakeSender:
    """Tests: records calls; `fail` is a list of exceptions raised by the next sends (consumed one per call)."""

    def __init__(self):
        self.sent: list[dict] = []
        self.fail: list[Exception] = []

    def _go(self, doc: dict) -> str:
        if self.fail:
            raise self.fail.pop(0)
        self.sent.append(doc)
        return f"wamid.fake{len(self.sent)}"

    def send_template(self, to, name, language, params):
        return self._go({"to": to, "template": name, "language": language, "params": params})

    def send_text(self, to, body):
        return self._go({"to": to, "text": body})


_override: WhatsAppSender | None = None


def set_sender(s: WhatsAppSender | None) -> None:
    global _override
    _override = s


def get_sender() -> WhatsAppSender | None:
    if _override is not None:
        return _override
    prov = settings.whatsapp_provider or ("file" if settings.env == "development" else "none")
    if prov == "meta" and settings.whatsapp_phone_number_id.strip() and settings.whatsapp_access_token.get_secret_value():
        return MetaCloudSender()
    if prov == "file" and settings.env == "development":
        return FileSender(settings.whatsapp_dev_dir)
    return None


def available() -> bool:
    return get_sender() is not None


# ---------------------------------------------------------------- contacts: opt-out and the 24-hour window
def _contact(db: Session, phone: str) -> WhatsAppContact | None:
    return db.get(WhatsAppContact, phone)


def is_opted_out(db: Session, phone: str) -> bool:
    c = _contact(db, phone)
    return bool(c and c.opted_out_at)


def window_open(db: Session, phone: str) -> bool:
    c = _contact(db, phone)
    return bool(c and c.last_inbound_at and c.last_inbound_at > _now() - WINDOW)


OPT_OUT_WORDS = {"stop", "stopall", "unsubscribe", "optout", "opt-out", "cancel", "बंद", "रोकें", "रुकें", "बन्द"}
OPT_IN_WORDS = {"start", "subscribe", "optin", "opt-in", "शुरू", "चालू"}


def record_inbound(phone: str, body: str | None) -> None:
    """One inbound message: opens the 24-hour window, and STOP / START change the opt-out. Own session; no tenant."""
    word = " ".join((body or "").lower().split()).strip(" .!")
    now = _now()
    values = {"phone": phone, "last_inbound_at": now}
    upd = {"last_inbound_at": now}
    if word in OPT_OUT_WORDS:
        values["opted_out_at"] = upd["opted_out_at"] = now
    elif word in OPT_IN_WORDS:
        values["opted_out_at"] = upd["opted_out_at"] = None
    with SessionLocal() as db:
        db.execute(pg_insert(WhatsAppContact).values(**values).on_conflict_do_update(index_elements=["phone"], set_=upd))
        db.commit()


def verify_signature(raw: bytes, header: str | None) -> bool:
    """X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(app secret, raw body). No app secret configured = nothing is accepted."""
    secret = settings.whatsapp_app_secret.get_secret_value()
    if not secret or not header or not header.startswith("sha256="):
        return False
    return hmac.compare_digest(header[7:], hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest())


def handle_webhook(payload: dict) -> int:
    """Processes inbound text messages of a Meta webhook payload; returns how many were handled."""
    n = 0
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            for m in (change.get("value") or {}).get("messages") or []:
                phone = normalize_phone("+" + str(m.get("from", "")).lstrip("+"))
                if not phone:
                    continue
                body = (m.get("text") or {}).get("body") or (m.get("button") or {}).get("text")
                record_inbound(phone, body)
                n += 1
    return n


# ---------------------------------------------------------------- outbox: queueing
def _row(db: Session, restaurant_id, **kw) -> WhatsAppOutbox:
    key = kw.get("dedupe_key")
    if key:
        existing = db.scalar(select(WhatsAppOutbox).where(WhatsAppOutbox.restaurant_id == restaurant_id,
                                                          WhatsAppOutbox.dedupe_key == key))
        if existing:
            return existing  # a double tap inside the same 10-minute bucket is one message
    row = WhatsAppOutbox(restaurant_id=restaurant_id, status="queued", attempts=0, **kw)
    db.add(row)
    db.flush()
    return row


def _guard(db: Session, phone: str) -> None:
    if not available():
        raise HTTPException(409, "WhatsApp is not set up on this server")
    if is_opted_out(db, phone):
        raise HTTPException(409, "This customer opted out of WhatsApp messages")


def bucket_key(kind: str, bill_id, phone: str) -> str:
    return f"{kind}:{bill_id}:{phone}:{int(time.time() // 600)}"[:100]


def enqueue_template(db: Session, restaurant_id, kind: str, to_phone: str, template: str, language: str, variables: list[str],
                     bill_id=None, created_by=None, dedupe_key: str | None = None) -> WhatsAppOutbox:
    """Adds a queued template message (caller commits, then calls `submit(deliver, ...)`)."""
    _guard(db, to_phone)
    return _row(db, restaurant_id, kind=kind, mode="template", to_phone=to_phone, template=template,
                language=language if language in LANGUAGES and comms_templates.languages_enabled() else "en", variables=[str(v)[:200] for v in variables],
                bill_id=bill_id, created_by=created_by, dedupe_key=dedupe_key)


def enqueue_text(db: Session, restaurant_id, to_phone: str, body: str, created_by=None, dedupe_key: str | None = None) -> WhatsAppOutbox:
    """Free text: only inside the 24-hour window opened by the customer's own last message; otherwise 409 (use a template)."""
    _guard(db, to_phone)
    if not window_open(db, to_phone):
        raise HTTPException(409, "The 24-hour window is closed: the customer has not messaged recently, send a template instead")
    return _row(db, restaurant_id, kind="text", mode="text", to_phone=to_phone, body=body[:1000], created_by=created_by,
                dedupe_key=dedupe_key)


# ---------------------------------------------------------------- outbox: delivery
def backoff_delays() -> list[float]:
    try:
        return [float(x) for x in settings.whatsapp_backoff_seconds.split(",") if x.strip()] or [60.0]
    except ValueError:
        return [60.0]


def deliver(tenant_id: uuid.UUID, outbox_id: uuid.UUID) -> None:
    """One attempt for one queued row (locked meanwhile). Never raises. Success -> sent; permanent error or the last try -> dead;
    otherwise queued again after the backoff."""
    try:
        with tenant_session(tenant_id) as db:
            row = db.scalar(select(WhatsAppOutbox).where(WhatsAppOutbox.id == outbox_id, WhatsAppOutbox.restaurant_id == tenant_id,
                                                         WhatsAppOutbox.status == "queued").with_for_update(skip_locked=True))
            if not row:
                return
            if is_opted_out(db, row.to_phone):
                row.status, row.last_error = "skipped", "customer opted out"
                db.commit()
                return
            sender = get_sender()
            row.attempts += 1
            try:
                if sender is None:
                    raise WhatsAppError("WhatsApp is not set up", retryable=True)
                if row.mode == "text":
                    if not window_open(db, row.to_phone):
                        raise WhatsAppError("24-hour window closed", retryable=False)
                    mid = sender.send_text(row.to_phone, row.body or "")
                else:
                    mid = sender.send_template(row.to_phone, row.template or "", row.language or "en", list(row.variables or []))
            except Exception as e:  # noqa: BLE001 - recorded, never raised
                retryable = getattr(e, "retryable", True)
                row.last_error = _safe_error(e)
                if not retryable or row.attempts >= settings.whatsapp_max_attempts:
                    row.status = "dead"
                    log.warning("whatsapp message %s is dead after %d attempt(s): %s", outbox_id, row.attempts, row.last_error)
                else:
                    d = backoff_delays()
                    row.next_attempt_at = _now() + timedelta(seconds=d[min(row.attempts - 1, len(d) - 1)])
                db.commit()
                return
            row.status, row.provider_message_id, row.sent_at, row.last_error = "sent", mid, _now(), None
            db.commit()
    except Exception:  # noqa: BLE001
        log.exception("whatsapp delivery %s crashed", outbox_id)


def retry(db: Session, tenant_id, outbox_id) -> WhatsAppOutbox:
    """Owner action: puts a dead / skipped message back in the queue with a fresh attempt budget."""
    row = db.scalar(select(WhatsAppOutbox).where(WhatsAppOutbox.id == outbox_id, WhatsAppOutbox.restaurant_id == tenant_id)
                    .with_for_update())
    if not row:
        raise HTTPException(404, "Message not found")
    if row.status not in ("dead", "skipped"):
        raise HTTPException(409, "Only a failed message can be retried")
    row.status, row.attempts, row.next_attempt_at, row.last_error = "queued", 0, _now(), None
    return row


_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="whatsapp")


def _safe(fn, *args) -> None:
    try:
        fn(*args)
    except Exception:  # noqa: BLE001
        log.exception("whatsapp background job failed")


def submit(fn, *args) -> None:
    """Runs fn(*args) off the request thread. Tests replace this to run inline or to hold jobs back."""
    _pool.submit(_safe, fn, *args)


_CLAIM = text("SELECT tenant_id, id FROM whatsapp_due_work(:now, :lim, :lease)")


def sweep(limit: int = 50) -> int:
    """The runner: claims due queued rows of every tenant (SECURITY DEFINER lease, app/core/definer.py) and delivers them.
    Returns the number of rows attempted. Safe to run from several workers."""
    if not available():
        return 0
    with SessionLocal() as db:
        due = db.execute(_CLAIM, {"now": _now(), "lim": limit, "lease": LEASE_SECONDS}).all()
        db.commit()
    for tenant_id, oid in due:
        deliver(tenant_id, oid)
    return len(due)


def start_sweeper() -> None:
    if settings.whatsapp_sweep_seconds <= 0:
        return

    def loop() -> None:
        while True:
            time.sleep(settings.whatsapp_sweep_seconds)
            try:
                sweep()
            except Exception:  # noqa: BLE001
                log.exception("whatsapp sweep failed")

    threading.Thread(target=loop, name="whatsapp-sweeper", daemon=True).start()
