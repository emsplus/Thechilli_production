"""Transactional outbox of the status webhooks POS -> delivery-service (docs/DELIVERY_API.md "Webhooks").

``enqueue`` runs inside the transaction that changes the order, so an event exists if and only if the change committed.
``run_once`` (the background runner, or scripts/run_delivery_outbox.py) delivers them:

* signature: ``X-Pos-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>``, header only (no secret in a URL),
  ``X-Pos-Timestamp`` (unix seconds, refreshed on every attempt so a retry stays inside the receiver's 5 minute window),
  ``X-Pos-Event-Id`` (fixed at creation: every retry carries the same id, so the receiver can dedupe), ``X-Pos-Restaurant-Id``;
* the secret is the restaurant's own (delivery_settings.webhook_secret);
* ordering: an event is claimed only when no EARLIER version of the same order is still pending; the payload carries the
  per-order monotonic ``version`` so a receiver ignores anything stale anyway;
* retry: attempt n waits base * 2^(n-1) seconds (capped); after delivery_outbox_max_attempts the row is ``dead`` (kept, visible,
  retryable by hand). 2xx = delivered; any other status or a network error = failed attempt; redirects are not followed.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import re
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import tenant_session
from app.models.core import DeliveryOrder, DeliveryOutbox, DeliverySettings

log = logging.getLogger("app.delivery.outbox")

EVENTS = ("order.accepted", "order.preparing", "order.ready", "order.cancelled", "order.payment_confirmed", "menu.changed")
LEASE_SECONDS = 60  # a claimed row is not claimed again for this long (a crashed sender's rows come back after it)
BATCH = 25

# Tests install an httpx transport here (and never open a socket).
transport: httpx.BaseTransport | None = None


def now() -> datetime:
    return datetime.now(timezone.utc)


def sign(secret: str, timestamp: str, raw_body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()


_NUMERIC_HOST = re.compile(r"^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}$", re.IGNORECASE)  # inet_aton shapes: 2130706433, 0x7f.1, 127.1


def _is_public_ip(ip: ipaddress._BaseAddress) -> bool:
    """True only for a globally routable address. Private, loopback, link-local (169.254.169.254), CGNAT (100.64/10), reserved,
    multicast and unspecified ranges are all refused; an IPv4-mapped IPv6 address is judged by the IPv4 it wraps."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def validate_webhook_url(url: str) -> str:
    """https only (http allowed for ENV=development); never a loopback / private / link-local address, an inet_aton-style
    numeric host (2130706433, 0x7f.1), a single-label host (a Docker service name such as `db`) or an internal suffix.
    This is the save-time check; `resolve_public` re-checks the DNS answer at send time (a name can point anywhere later)."""
    parts = urlsplit(url)
    dev = settings.env == "development"
    if parts.scheme not in (("https", "http") if dev else ("https",)) or not parts.hostname:
        raise ValueError("webhook_url must be an https URL")
    if parts.username or parts.password:
        raise ValueError("webhook_url must not carry credentials")
    host = parts.hostname
    if not dev:
        try:
            bad = not _is_public_ip(ipaddress.ip_address(host))
        except ValueError:
            bad = (host == "localhost" or "." not in host or _NUMERIC_HOST.match(host) is not None
                   or host.endswith((".local", ".internal", ".localhost", ".lan", ".home", ".corp", ".intranet")))
        if bad:
            raise ValueError("webhook_url must not point at a private or loopback address")
    return url


def resolve_public(host: str, port: int) -> str:
    """The IP to connect to: DNS is resolved NOW and every answer must be public, else ValueError. The caller connects to
    this address (not the name again), so a rebinding DNS server cannot swap in an internal address after the check."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as e:
        raise ValueError(f"webhook host does not resolve: {host}") from e
    ips = [ipaddress.ip_address(i[4][0]) for i in infos]
    if not ips or not all(_is_public_ip(i) for i in ips):
        raise ValueError("webhook_url resolves to a private or loopback address")
    return str(ips[0])


def enqueue(db: Session, d: DeliveryOrder, event_type: str, **extra) -> DeliveryOutbox | None:
    """Writes the event for the CURRENT state of `d` (call after bumping d.version). No webhook configured = nothing to send."""
    assert event_type in EVENTS, event_type
    cfg = db.get(DeliverySettings, d.restaurant_id)
    if cfg is None or not cfg.webhook_url or not cfg.webhook_secret:
        return None
    payload = {"event": event_type, "restaurant_id": str(d.restaurant_id), "order_id": str(d.order_id),
               "order_code": d.order_code, "version": d.version, "status": d.delivery_status,
               "occurred_at": now().isoformat(), **extra}
    row = DeliveryOutbox(restaurant_id=d.restaurant_id, order_id=d.order_id, event_id=uuid.uuid4().hex,
                         event_type=event_type, version=d.version, payload=payload)
    db.add(row)
    return row


def backoff_seconds(attempts: int) -> int:
    return min(settings.delivery_outbox_backoff_base_seconds * 2 ** max(attempts - 1, 0),
               settings.delivery_outbox_backoff_max_seconds)


def _claim(db: Session, limit: int) -> list[uuid.UUID]:
    """Due rows (oldest version first per order), leased so no other runner sends them meanwhile. One short transaction."""
    rows = db.execute(text("""
        SELECT o.id FROM delivery_outbox o
         WHERE o.status = 'pending' AND o.next_attempt_at <= :now
           AND NOT EXISTS (SELECT 1 FROM delivery_outbox e
                            WHERE e.order_id = o.order_id AND e.status = 'pending' AND e.version < o.version)
         ORDER BY o.order_id, o.version LIMIT :n FOR UPDATE SKIP LOCKED"""), {"now": now(), "n": limit}).all()
    ids = [r.id for r in rows]
    if ids:
        db.execute(text("UPDATE delivery_outbox SET next_attempt_at = :t WHERE id = ANY(:ids)"),
                   {"t": now() + timedelta(seconds=LEASE_SECONDS), "ids": ids})
    db.commit()
    return ids


def _post(url: str, secret: str, row: DeliveryOutbox) -> None:
    raw = json.dumps(row.payload, separators=(",", ":"), sort_keys=True).encode()
    ts = str(int(time.time()))
    headers = {"Content-Type": "application/json", "X-Pos-Timestamp": ts, "X-Pos-Signature": sign(secret, ts, raw),
               "X-Pos-Event-Id": row.event_id, "X-Pos-Restaurant-Id": str(row.restaurant_id)}
    extensions: dict = {}
    if transport is None and settings.env != "development":
        # SSRF guard (tenant-chosen URL): resolve now, require a public address, connect to that address, keep the name for
        # the Host header and TLS (SNI + certificate check).
        parts = urlsplit(url)
        port = parts.port or 443
        ip = resolve_public(parts.hostname, port)
        netloc = f"[{ip}]" if ":" in ip else ip
        extensions["sni_hostname"] = parts.hostname
        headers["Host"] = parts.netloc.rpartition("@")[2]
        url = parts._replace(netloc=f"{netloc}:{port}").geturl()
    with httpx.Client(timeout=settings.delivery_webhook_timeout_seconds, transport=transport, follow_redirects=False) as c:
        r = c.post(url, content=raw, headers=headers, extensions=extensions)
    if not 200 <= r.status_code < 300:
        raise RuntimeError(f"receiver answered {r.status_code}")


def _deliver_one(db: Session, row_id: uuid.UUID, blocked_orders: set) -> bool:
    """True when the event was delivered."""
    row = db.get(DeliveryOutbox, row_id)
    if row is None or row.status != "pending":
        return False
    cfg = db.get(DeliverySettings, row.restaurant_id)
    err = None
    if row.order_id in blocked_orders:  # an earlier event of this order failed in this run: keep the order of events
        row.next_attempt_at = now()
        db.commit()
        return False
    if cfg is None or not cfg.webhook_url or not cfg.webhook_secret:
        err = "webhook is not configured"
    else:
        try:
            _post(cfg.webhook_url, cfg.webhook_secret, row)
        except Exception as e:  # noqa: BLE001 - any failure is a failed attempt
            err = f"{type(e).__name__}: {e}"[:300]
    if err is None:
        row.status, row.sent_at, row.last_error = "sent", now(), None
        db.commit()
        return True
    row.attempts += 1
    row.last_error = err
    if row.attempts >= settings.delivery_outbox_max_attempts:
        row.status = "dead"
        log.error("delivery webhook %s for order %s is dead after %d attempts: %s", row.event_id, row.order_id, row.attempts, err)
    else:
        row.next_attempt_at = now() + timedelta(seconds=backoff_seconds(row.attempts))
    blocked_orders.add(row.order_id)
    db.commit()
    return False


def run_once() -> int:
    """One pass over every tenant with a due event. Returns the number of events delivered."""
    with SessionLocal() as db:
        tenants = [r.tenant_id for r in db.execute(text("SELECT tenant_id FROM delivery_outbox_tenants(:n)"), {"n": now()})]
    sent = 0
    for tid in tenants:
        with tenant_session(tid) as db:
            ids = _claim(db, BATCH)
            blocked: set = set()
            for rid in ids:
                if _deliver_one(db, rid, blocked):
                    sent += 1
    return sent


def start_runner() -> None:
    every = settings.delivery_outbox_sweep_seconds
    if every <= 0:
        return

    def loop() -> None:
        while True:
            time.sleep(every)
            try:
                run_once()
            except Exception:
                log.exception("delivery outbox run failed")

    threading.Thread(target=loop, name="delivery-outbox", daemon=True).start()
