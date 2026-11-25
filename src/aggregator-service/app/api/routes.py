import hashlib
import hmac
import json
import secrets
import time
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import (
    Caller,
    Internal,
    get_session,
    require_admin,
    require_caller,
    require_worker,
)
from app.core.config import settings
from app.core.errors import AppError
from app.core.ratelimit import limiter
from app.core.security import (
    _TENANT_RE,
    MAX_TENANT_LEN,
    resolve_secret,
    validate_secret_ref,
)
from app.models import (
    AuditLog,
    MenuMapping,
    Order,
    OrderStatus,
    OutboundJob,
    Payout,
    PayoutLine,
    StoreMapping,
    WebhookReplay,
    now,
)
from app.providers.base import Money, ParseError  # noqa: F401
from app.services import menu as menu_svc
from app.services import orders as orders_svc
from app.services import outbox, settlement
from app.services.audit import audit
from app.services.handlers import build_handlers

router = APIRouter(prefix="/api/v1")


@router.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------- inbound webhook (per-store signature)
async def _read_capped(request: Request, cap: int) -> bytes:
    """Never buffers more than `cap` bytes: Content-Length is checked first, then the stream is counted."""
    cl = request.headers.get("content-length", "")
    if cl.isdigit() and int(cl) > cap:
        raise AppError(413, "payload_too_large", "request body too large")
    chunks, n = [], 0
    async for chunk in request.stream():
        n += len(chunk)
        if n > cap:
            raise AppError(413, "payload_too_large", "request body too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _reject(s: Session, key, mapping: StoreMapping, provider: str, reason: str, status: int = 401) -> AppError:
    """Failed authentication: counted per (source, store) and audited only while under the bound. No body is stored."""
    if limiter.record(key):
        audit(s, actor=f"provider:{provider}", action="webhook.signature_rejected", tenant_id=mapping.tenant_id,
              entity_type="store_mapping", entity_id=mapping.id, reason=reason)
        s.commit()
    return AppError(status, "bad_signature", "signature verification failed")


@router.post("/webhooks/{provider}/{mapping_id}", status_code=202)
async def webhook(provider: str, mapping_id: uuid.UUID, request: Request, s: Session = Depends(get_session)):
    """The URL carries the store mapping, so the secret that must sign the request is that store's own (a per-tenant
    secret held in the environment, referenced by name); one store's secret can never authenticate another's."""
    adapter = request.app.state.registry.get(provider)
    if adapter is None:
        raise AppError(404, "unknown_provider", "unknown provider")
    key = (request.client.host if request.client else "?", str(mapping_id))
    if limiter.blocked(key):
        raise AppError(429, "rate_limited", "too many failed attempts")
    body = await _read_capped(request, settings.webhook_max_body_bytes)
    m = s.scalar(select(StoreMapping).where(StoreMapping.id == mapping_id, StoreMapping.provider == provider))
    if m is None:
        raise AppError(404, "not_found", "unknown store")  # nothing written for unauthenticated unknown targets
    try:
        secret = resolve_secret(m.webhook_secret_ref, m.tenant_id)
    except AppError:
        raise AppError(503, "secret_unavailable", "webhook secret is not configured for this store")  # fail closed
    if not adapter.verify_signature(request.headers, body, secret):
        raise _reject(s, key, m, provider, "bad_signature")
    ts = adapter.webhook_timestamp(request.headers)
    if ts is None or abs(time.time() - ts) > settings.webhook_tolerance_seconds:
        raise _reject(s, key, m, provider, "timestamp_outside_window")
    # the signature is a function of (secret, timestamp, body), so (store, timestamp, body hash) identifies a request
    replay_id = hashlib.sha256(f"{m.id}|{ts!r}|{hashlib.sha256(body).hexdigest()}".encode()).hexdigest()
    s.execute(delete(WebhookReplay).where(WebhookReplay.seen_at < now() - timedelta(
        seconds=2 * settings.webhook_tolerance_seconds)))
    try:
        with s.begin_nested():
            s.add(WebhookReplay(id=replay_id))
            s.flush()
    except IntegrityError:
        s.commit()
        raise AppError(409, "replayed_webhook", "this exact webhook was already processed")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise TypeError("not an object")
    except (ValueError, TypeError):
        orders_svc._event(s, provider, {"_unparseable_body": body.decode("utf-8", "replace")}, "invalid",
                          ext_store=m.external_store_id, error="body is not a JSON object")
        s.commit()
        raise AppError(422, "invalid_payload", "body is not a JSON object")
    ver = adapter.parse_store_verification(payload)
    if ver is not None:
        return _confirm_store(s, m, ver)
    if not m.verified or not m.active:
        s.commit()
        raise AppError(403, "store_not_verified", "store ownership has not been proven (or the mapping is inactive)")
    outcome, order = orders_svc.ingest_webhook(s, adapter, m, payload)
    s.commit()
    if outcome == "invalid":
        raise AppError(422, "invalid_payload", "payload recorded but could not be normalized")
    return {"outcome": outcome, "order_id": str(order.id) if order else None,
            "status": order.status if order else None}


def _confirm_store(s: Session, m: StoreMapping, ver: tuple[str, str]) -> dict:
    ext, code = ver
    if ext != m.external_store_id or not m.verification_code or not hmac.compare_digest(code, m.verification_code):
        audit(s, actor=f"provider:{m.provider}", action="store_mapping.verification_failed", tenant_id=m.tenant_id,
              entity_type="store_mapping", entity_id=m.id)
        s.commit()
        raise AppError(403, "bad_verification", "verification code does not match")
    if not m.verified:
        try:
            with s.begin_nested():
                m.verified, m.verified_at, m.verification_code = True, now(), None
                s.flush()
        except IntegrityError:  # another tenant already proved ownership; only an admin override can move it
            s.expire(m)
            audit(s, actor=f"provider:{m.provider}", action="store_mapping.verification_conflict",
                  tenant_id=m.tenant_id, entity_type="store_mapping", entity_id=m.id)
            s.commit()
            raise AppError(409, "store_owned", "store is already verified for another tenant")
        audit(s, actor=f"provider:{m.provider}", action="store_mapping.verified", tenant_id=m.tenant_id,
              entity_type="store_mapping", entity_id=m.id)
    s.commit()
    return {"outcome": "store_verified", "order_id": None, "status": None}


# ---------------------------------------------------------------- store + menu mappings
class StoreIn(BaseModel):
    outlet_id: str = Field(min_length=1, max_length=64)
    provider: str = Field(min_length=1, max_length=32)
    external_store_id: str = Field(min_length=1, max_length=128)
    webhook_secret_ref: str = Field(min_length=1, max_length=64)  # env var NAME in AGG_SECRET_<TENANT>__ namespace


def _store_out(m: StoreMapping, with_code: bool = True) -> dict:
    return {"id": str(m.id), "outlet_id": m.outlet_id, "provider": m.provider,
            "external_store_id": m.external_store_id, "active": m.active, "verified": m.verified,
            "webhook_secret_ref": m.webhook_secret_ref, "webhook_path": f"/api/v1/webhooks/{m.provider}/{m.id}",
            "verification_code": m.verification_code if with_code and not m.verified else None}


@router.post("/store-mappings", status_code=201)
def create_store(b: StoreIn, request: Request, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    """Registers a CLAIM. It receives no orders until the provider confirms ownership by sending the issued
    verification code for this external store, signed with this store's secret. Unverified claims never block
    anyone else, so a tenant cannot squat another tenant's external store id."""
    if request.app.state.registry.get(b.provider) is None:
        raise AppError(422, "unknown_provider", "provider has no registered adapter")
    validate_secret_ref(b.webhook_secret_ref, a.tenant_id)
    m = StoreMapping(tenant_id=a.tenant_id, verified=False, verification_code=secrets.token_urlsafe(24),
                     **b.model_dump())
    try:
        with s.begin_nested():
            s.add(m)
            s.flush()
    except IntegrityError:
        raise AppError(409, "conflict", "this tenant already maps that store or outlet+provider")
    audit(s, actor=a.actor, action="store_mapping.created", tenant_id=a.tenant_id, entity_type="store_mapping",
          entity_id=m.id, outlet_id=b.outlet_id, provider=b.provider, external_store_id=b.external_store_id)
    s.commit()
    return _store_out(m)


class ClaimIn(StoreIn):
    tenant_id: str


@router.post("/admin/store-mappings/claim", status_code=201)
def admin_claim_store(b: ClaimIn, request: Request, w: Internal = Depends(require_admin),
                      s: Session = Depends(get_session)):
    """Platform-admin override after out-of-band proof (e.g. partner contract): marks the store verified for the
    named tenant and revokes any other tenant's verification of the same provider+external store."""
    if request.app.state.registry.get(b.provider) is None:
        raise AppError(422, "unknown_provider", "provider has no registered adapter")
    if not _TENANT_RE.match(b.tenant_id) or len(b.tenant_id) > MAX_TENANT_LEN:
        raise AppError(422, "invalid_tenant", "invalid tenant id")
    validate_secret_ref(b.webhook_secret_ref, b.tenant_id)
    revoked = []
    for other in s.scalars(select(StoreMapping).where(
            StoreMapping.provider == b.provider, StoreMapping.external_store_id == b.external_store_id,
            StoreMapping.verified.is_(True), StoreMapping.tenant_id != b.tenant_id)):
        other.verified, other.active = False, False
        revoked.append(other.tenant_id)
    s.flush()
    m = s.scalar(select(StoreMapping).where(
        StoreMapping.tenant_id == b.tenant_id, StoreMapping.provider == b.provider,
        StoreMapping.external_store_id == b.external_store_id))
    try:
        with s.begin_nested():
            if m is None:
                m = StoreMapping(tenant_id=b.tenant_id, **b.model_dump(exclude={"tenant_id"}))
                s.add(m)
            m.outlet_id, m.webhook_secret_ref = b.outlet_id, b.webhook_secret_ref
            m.verified, m.active, m.verified_at, m.verification_code = True, True, now(), None
            s.flush()
    except IntegrityError:
        raise AppError(409, "conflict", "tenant already maps that outlet+provider to another store")
    audit(s, actor=w.actor, action="store_mapping.admin_claimed", tenant_id=b.tenant_id, entity_type="store_mapping",
          entity_id=m.id, external_store_id=b.external_store_id, provider=b.provider, revoked_from=revoked)
    s.commit()
    return _store_out(m, with_code=False)


@router.get("/store-mappings")
def list_stores(a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    rows = s.scalars(select(StoreMapping).where(StoreMapping.tenant_id == a.tenant_id).order_by(StoreMapping.created_at))
    return [_store_out(r) for r in rows]


class MenuMapIn(BaseModel):  # bounds match the menu_mappings columns: longer values would be a DB error (500)
    outlet_id: str = Field(min_length=1, max_length=64)
    provider: str = Field(min_length=1, max_length=32)
    external_item_id: str = Field(min_length=1, max_length=128)
    internal_item_id: str = Field(min_length=1, max_length=64)


@router.put("/menu-mappings")
def upsert_menu_mapping(b: MenuMapIn, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    m = s.scalar(select(MenuMapping).where(MenuMapping.tenant_id == a.tenant_id, MenuMapping.outlet_id == b.outlet_id,
                                           MenuMapping.provider == b.provider,
                                           MenuMapping.external_item_id == b.external_item_id))
    if m:
        m.internal_item_id = b.internal_item_id
    else:
        s.add(MenuMapping(tenant_id=a.tenant_id, **b.model_dump()))
    audit(s, actor=a.actor, action="menu_mapping.upserted", tenant_id=a.tenant_id, **b.model_dump())
    promoted = orders_svc.reresolve_unmapped(s, a.tenant_id, b.outlet_id, b.provider, a.actor)
    s.commit()
    return {"promoted_orders": [str(o.id) for o in promoted]}


@router.get("/menu-mappings/unmapped")
def unmapped(outlet_id: str, provider: str, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    """External items seen on orders that still have no internal mapping: the worklist for whoever maps the menu."""
    rows = s.execute(select(Order.id, Order.external_order_id).where(
        Order.tenant_id == a.tenant_id, Order.outlet_id == outlet_id, Order.provider == provider,
        Order.status == OrderStatus.NEEDS_MAPPING.value)).all()
    out: dict[str, dict] = {}
    for o in s.scalars(select(Order).where(Order.id.in_([r.id for r in rows]))):
        for i in o.items:
            if i.internal_item_id is None:
                e = out.setdefault(i.external_item_id, {"external_item_id": i.external_item_id, "name": i.name,
                                                        "order_ids": []})
                e["order_ids"].append(str(o.id))
    return list(out.values())


# ---------------------------------------------------------------- orders
def _order_out(o: Order) -> dict:
    return {"id": str(o.id), "provider": o.provider, "external_order_id": o.external_order_id,
            "outlet_id": o.outlet_id, "status": o.status, "total_minor": o.total_minor, "currency": o.currency,
            "pos_state": o.pos_state, "pos_order_id": o.pos_order_id, "pos_reject_code": o.pos_reject_code,
            "pos_reject_reason": o.pos_reject_reason,
            "items": [{"line_no": i.line_no, "external_item_id": i.external_item_id,
                       "internal_item_id": i.internal_item_id, "name": i.name, "quantity": i.quantity,
                       "unit_price_minor": i.unit_price_minor} for i in o.items]}


@router.get("/orders")
def list_orders(status: str | None = None, pos_state: str | None = None, a: Caller = Depends(require_caller),
                s: Session = Depends(get_session)):
    q = select(Order).where(Order.tenant_id == a.tenant_id).order_by(Order.created_at.desc()).limit(200)
    if status:
        q = q.where(Order.status == status)
    if pos_state:
        q = q.where(Order.pos_state == pos_state)
    return [_order_out(o) for o in s.scalars(q)]


@router.get("/orders/{order_id}")
def get_order(order_id: uuid.UUID, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    o = s.scalar(select(Order).where(Order.id == order_id, Order.tenant_id == a.tenant_id))
    if o is None:
        raise AppError(404, "not_found", "order not found")
    return _order_out(o)


class ActionIn(BaseModel):
    reason: str | None = None


ACTIONS = {"accept": OrderStatus.ACCEPTED, "reject": OrderStatus.REJECTED, "ready": OrderStatus.READY,
           "dispatch": OrderStatus.DISPATCHED, "deliver": OrderStatus.DELIVERED, "cancel": OrderStatus.CANCELLED}


@router.post("/orders/{order_id}/{action}")
def order_action(order_id: uuid.UUID, action: str, b: ActionIn | None = None, a: Caller = Depends(require_caller),
                 s: Session = Depends(get_session)):
    if action not in ACTIONS:
        raise AppError(404, "not_found", "unknown action")
    o = orders_svc.get_order_locked(s, a.tenant_id, order_id)
    if o is None:
        raise AppError(404, "not_found", "order not found")
    try:
        orders_svc.transition(s, o, ACTIONS[action], actor=a.actor, reason=b.reason if b else None)
    except orders_svc.IllegalTransition as e:
        raise AppError(409, "illegal_transition", str(e))
    s.commit()
    return _order_out(o)


# ---------------------------------------------------------------- outbound menu / availability
class MenuItemIn(BaseModel):
    internal_item_id: str
    name: str
    price_minor: Money
    available: bool = True


class MenuSyncIn(BaseModel):
    outlet_id: str
    provider: str
    version: str  # caller-chosen; re-sending the same version is a no-op (idempotent)
    items: list[MenuItemIn]


@router.post("/menu-sync", status_code=202)
def menu_sync(b: MenuSyncIn, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    job, unmapped_ids = menu_svc.enqueue_menu_sync(s, a.tenant_id, b.outlet_id, b.provider,
                                                   [i.model_dump() for i in b.items], b.version)
    audit(s, actor=a.actor, action="menu_sync.requested", tenant_id=a.tenant_id, outlet_id=b.outlet_id,
          provider=b.provider, unmapped=unmapped_ids)
    s.commit()
    return {"job_id": str(job.id) if job else None, "unmapped_internal_item_ids": unmapped_ids}


class AvailabilityIn(BaseModel):
    outlet_id: str
    internal_item_id: str
    available: bool
    version: str


@router.post("/availability", status_code=202)
def availability(b: AvailabilityIn, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    queued = menu_svc.enqueue_availability(s, a.tenant_id, b.outlet_id, b.internal_item_id, b.available, b.version)
    audit(s, actor=a.actor, action="availability.requested", tenant_id=a.tenant_id, **b.model_dump(),
          providers=queued)
    s.commit()
    return {"providers_queued": queued}


# ---------------------------------------------------------------- jobs
@router.post("/jobs/run")
def run_jobs(request: Request, w: Internal = Depends(require_worker), s: Session = Depends(get_session)):
    """Worker-only: executes every tenant's due outbox rows, so no tenant credential may call it."""
    handlers = build_handlers(request.app.state.registry, request.app.state.pos_client)
    return outbox.run_due(s, handlers)


@router.get("/jobs")
def list_jobs(status: str | None = None, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    q = select(OutboundJob).where(OutboundJob.tenant_id == a.tenant_id).order_by(OutboundJob.created_at).limit(200)
    if status:
        q = q.where(OutboundJob.status == status)
    return [{"id": str(j.id), "kind": j.kind, "provider": j.provider, "status": j.status, "attempts": j.attempts,
             "next_attempt_at": j.next_attempt_at, "last_error": j.last_error} for j in s.scalars(q)]


# ---------------------------------------------------------------- settlements
class PayoutLineIn(BaseModel):
    external_order_id: str
    gross_minor: Money
    commission_minor: Money
    net_minor: Money


class PayoutIn(BaseModel):
    provider: str
    external_payout_id: str
    currency: str = Field(min_length=3, max_length=3)
    period_start: datetime
    period_end: datetime
    gross_minor: Money
    commission_minor: Money
    fees_minor: Money = 0
    net_minor: Money
    lines: list[PayoutLineIn] = Field(max_length=5000)


def _payout_out(p: Payout) -> dict:
    return {"id": str(p.id), "provider": p.provider, "external_payout_id": p.external_payout_id, "status": p.status,
            "discrepancies": p.discrepancies,
            "lines": [{"external_order_id": l.external_order_id, "match_status": l.match_status} for l in p.lines]}


@router.post("/settlements/import")
def import_payout(b: PayoutIn, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    """Idempotent on (provider, external_payout_id): re-importing returns the stored payout unchanged."""
    p = s.scalar(select(Payout).where(Payout.tenant_id == a.tenant_id, Payout.provider == b.provider,
                                      Payout.external_payout_id == b.external_payout_id))
    if p:
        return _payout_out(p)
    p = Payout(tenant_id=a.tenant_id, **b.model_dump(exclude={"lines"}),
               lines=[PayoutLine(**l.model_dump()) for l in b.lines])
    try:
        with s.begin_nested():
            s.add(p)
            s.flush()
    except IntegrityError:
        raise AppError(409, "conflict", "concurrent import of the same payout")
    audit(s, actor=a.actor, action="payout.imported", tenant_id=a.tenant_id, entity_type="payout", entity_id=p.id,
          provider=b.provider, external_payout_id=b.external_payout_id)
    settlement.reconcile(s, p)
    s.commit()
    return _payout_out(p)


@router.post("/settlements/{payout_id}/reconcile")
def reconcile_payout(payout_id: uuid.UUID, a: Caller = Depends(require_caller), s: Session = Depends(get_session)):
    p = s.scalar(select(Payout).where(Payout.id == payout_id, Payout.tenant_id == a.tenant_id))
    if p is None:
        raise AppError(404, "not_found", "payout not found")
    settlement.reconcile(s, p)
    s.commit()
    return _payout_out(p)


@router.get("/audit")
def audit_log(action: str | None = None, entity_id: str | None = None, a: Caller = Depends(require_caller),
              s: Session = Depends(get_session)):
    q = select(AuditLog).where(AuditLog.tenant_id == a.tenant_id).order_by(AuditLog.id.desc()).limit(200)
    if action:
        q = q.where(AuditLog.action == action)
    if entity_id:
        q = q.where(AuditLog.entity_id == entity_id)
    return [{"id": r.id, "at": r.at, "actor": r.actor, "action": r.action, "entity_type": r.entity_type,
             "entity_id": r.entity_id, "details": r.details} for r in s.scalars(q)]
