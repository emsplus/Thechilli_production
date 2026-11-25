import hashlib
import json
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    InboundEvent,
    MenuMapping,
    Order,
    OrderEvent,
    OrderItem,
    StoreMapping,
)
from app.models import OrderStatus as S
from app.providers.base import CanonicalOrder, ParseError, ProviderAdapter
from app.services.audit import audit
from app.services.outbox import enqueue

# State machine. Terminal: delivered, rejected, cancelled.
TRANSITIONS: dict[S, set[S]] = {
    S.NEEDS_MAPPING: {S.RECEIVED, S.REJECTED, S.CANCELLED},
    S.RECEIVED: {S.ACCEPTED, S.REJECTED, S.CANCELLED},
    S.ACCEPTED: {S.READY, S.CANCELLED},
    S.READY: {S.DISPATCHED, S.CANCELLED},
    S.DISPATCHED: {S.DELIVERED, S.CANCELLED},
    S.DELIVERED: set(), S.REJECTED: set(), S.CANCELLED: set(),
}
PUSHED = {S.ACCEPTED, S.REJECTED, S.READY, S.DISPATCHED, S.DELIVERED, S.CANCELLED}


class IllegalTransition(Exception):
    pass


def transition(s: Session, order: Order, to: S, *, actor: str, reason: str | None = None) -> None:
    frm = S(order.status)
    if to not in TRANSITIONS[frm]:
        raise IllegalTransition(f"{frm.value} -> {to.value} is not allowed")
    if to == S.ACCEPTED and any(i.internal_item_id is None for i in order.items):
        raise IllegalTransition("order has unmapped items")  # defensive; NEEDS_MAPPING already blocks this
    order.status = to.value
    s.add(OrderEvent(order_id=order.id, from_status=frm.value, to_status=to.value, actor=actor, reason=reason))
    audit(s, actor=actor, action=f"order.{to.value}", tenant_id=order.tenant_id, entity_type="order",
          entity_id=order.id, from_status=frm.value, reason=reason)
    if to in PUSHED:
        enqueue(s, kind="push_status", tenant_id=order.tenant_id, provider=order.provider, order_id=order.id,
                key=f"push_status:{order.id}:{to.value}",
                payload={"external_order_id": order.external_order_id, "status": to.value, "reason": reason})
    if to == S.ACCEPTED:
        order.pos_state = "pending"
        enqueue(s, kind="deliver_to_pos", tenant_id=order.tenant_id, provider=order.provider, order_id=order.id,
                key=f"deliver_to_pos:{order.id}", payload={})


def get_order_locked(s: Session, tenant_id: str, order_id: uuid.UUID) -> Order | None:
    return s.scalar(select(Order).where(Order.id == order_id, Order.tenant_id == tenant_id).with_for_update())


def _sha(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def _event(s, provider, payload, status, *, canon=None, error=None, order_id=None, ext_order=None, ext_store=None):
    ev = InboundEvent(provider=provider, payload=payload, status=status, error=error, order_id=order_id,
                      external_order_id=canon.external_order_id if canon else ext_order,
                      external_store_id=canon.external_store_id if canon else ext_store)
    s.add(ev)
    return ev


def ingest_webhook(s: Session, adapter: ProviderAdapter, store: StoreMapping,
                   payload: dict) -> tuple[str, Order | None]:
    """Returns (outcome, order). outcome: created | duplicate | invalid. `store` is the verified mapping the webhook
    URL (and so the signing secret) belongs to: the payload cannot choose a different tenant's store. Every outcome
    leaves an InboundEvent with the verbatim payload. Caller commits."""
    provider = adapter.name
    try:
        canon = adapter.parse_order_webhook(payload)
    except ParseError as e:
        _event(s, provider, payload, "invalid", error=str(e))
        audit(s, actor=f"provider:{provider}", action="webhook.invalid", error=str(e))
        return "invalid", None
    if canon.external_store_id != store.external_store_id:
        _event(s, provider, payload, "invalid", canon=canon, error="payload store does not match the webhook's store")
        audit(s, actor=f"provider:{provider}", action="webhook.store_mismatch", tenant_id=store.tenant_id,
              external_store_id=canon.external_store_id)
        return "invalid", None
    return ingest_canonical(s, provider, store, canon, payload)


def ingest_canonical(s: Session, provider: str, store: StoreMapping, canon: CanonicalOrder,
                     payload: dict) -> tuple[str, Order | None]:
    actor = f"provider:{provider}"
    existing = s.scalar(select(Order).where(Order.tenant_id == store.tenant_id, Order.provider == provider,
                                            Order.external_order_id == canon.external_order_id))
    digest = _sha(payload)
    if existing:
        return _duplicate(s, provider, canon, payload, existing, digest)
    maps = {m.external_item_id: m.internal_item_id for m in s.scalars(
        select(MenuMapping).where(MenuMapping.tenant_id == store.tenant_id, MenuMapping.outlet_id == store.outlet_id,
                                  MenuMapping.provider == provider,
                                  MenuMapping.external_item_id.in_([i.external_item_id for i in canon.items])))}
    unmapped = [i.external_item_id for i in canon.items if i.external_item_id not in maps]
    order = Order(
        tenant_id=store.tenant_id, outlet_id=store.outlet_id, provider=provider,
        external_order_id=canon.external_order_id, external_store_id=canon.external_store_id,
        status=(S.NEEDS_MAPPING if unmapped else S.RECEIVED).value, fulfilment_type=canon.fulfilment_type,
        customer_name=canon.customer_name, customer_phone=canon.customer_phone, notes=canon.notes,
        currency=canon.currency.upper(), subtotal_minor=canon.subtotal_minor, tax_minor=canon.tax_minor,
        delivery_fee_minor=canon.delivery_fee_minor, discount_minor=canon.discount_minor,
        total_minor=canon.total_minor, placed_at=canon.placed_at, payload_sha256=digest, raw_payload=payload,
        items=[OrderItem(line_no=n, external_item_id=i.external_item_id,
                         internal_item_id=maps.get(i.external_item_id), name=i.name, quantity=i.quantity,
                         unit_price_minor=i.unit_price_minor) for n, i in enumerate(canon.items, 1)])
    try:
        with s.begin_nested():
            s.add(order)
            s.flush()
    except IntegrityError:  # lost a race with a concurrent delivery of the same order
        existing = s.scalar(select(Order).where(Order.tenant_id == store.tenant_id, Order.provider == provider,
                                                Order.external_order_id == canon.external_order_id))
        return _duplicate(s, provider, canon, payload, existing, digest)
    s.add(OrderEvent(order_id=order.id, from_status=None, to_status=order.status, actor=actor))
    _event(s, provider, payload, "ingested", canon=canon, order_id=order.id)
    audit(s, actor=actor, action="order.ingested", tenant_id=order.tenant_id, entity_type="order",
          entity_id=order.id, status=order.status, unmapped_external_item_ids=unmapped)
    return "created", order


def _duplicate(s, provider, canon, payload, existing, digest):
    _event(s, provider, payload, "duplicate", canon=canon, order_id=existing.id)
    audit(s, actor=f"provider:{provider}", action="webhook.duplicate", tenant_id=existing.tenant_id,
          entity_type="order", entity_id=existing.id, payload_differs=existing.payload_sha256 != digest)
    return "duplicate", existing


def reresolve_unmapped(s: Session, tenant_id: str, outlet_id: str, provider: str, actor: str) -> list[Order]:
    """After a mapping is added: fill internal ids on NEEDS_MAPPING orders; those fully mapped become RECEIVED."""
    maps = {m.external_item_id: m.internal_item_id for m in s.scalars(select(MenuMapping).where(
        MenuMapping.tenant_id == tenant_id, MenuMapping.outlet_id == outlet_id, MenuMapping.provider == provider))}
    promoted = []
    for o in s.scalars(select(Order).where(Order.tenant_id == tenant_id, Order.outlet_id == outlet_id,
                                           Order.provider == provider, Order.status == S.NEEDS_MAPPING.value)
                       .with_for_update()):
        for i in o.items:
            if i.internal_item_id is None:
                i.internal_item_id = maps.get(i.external_item_id)
        if all(i.internal_item_id for i in o.items):
            transition(s, o, S.RECEIVED, actor=actor, reason="all items mapped")
            promoted.append(o)
    return promoted
