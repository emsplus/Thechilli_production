"""Outbound job handlers. Built per worker run with the provider registry and the pos client injected."""

from app.models import Order, OrderStatus
from app.pos.client import PosClient, PosLine, PosOrderRequest
from app.providers.base import MenuEntry, PermanentError
from app.providers.registry import Registry
from app.services.audit import audit


def build_handlers(registry: Registry, pos: PosClient) -> dict:
    def adapter(job):
        a = registry.get(job.provider)
        if a is None:
            raise PermanentError(f"no adapter registered for provider {job.provider!r}")
        return a

    def push_status(s, job):
        p = job.payload
        adapter(job).push_status(p["external_order_id"], p["status"], p.get("reason"))

    def menu_sync(s, job):
        p = job.payload
        adapter(job).sync_menu(p["external_store_id"], [MenuEntry(**i) for i in p["items"]])

    def set_availability(s, job):
        p = job.payload
        adapter(job).set_item_availability(p["external_store_id"], p["external_item_id"], p["available"])

    def deliver_to_pos(s, job):
        o = s.get(Order, job.order_id)
        if o is None or o.tenant_id != job.tenant_id:
            raise PermanentError("job does not reference an order of its own tenant")
        if o.pos_state == "delivered":
            return
        if OrderStatus(o.status) in (OrderStatus.CANCELLED, OrderStatus.REJECTED):
            return  # cancelled before delivery; nothing to send
        req = PosOrderRequest(
            idempotency_key=f"{o.provider}:{o.external_order_id}", tenant_id=o.tenant_id, outlet_id=o.outlet_id,
            source=o.provider, external_order_id=o.external_order_id, currency=o.currency, total_minor=o.total_minor,
            lines=[PosLine(internal_item_id=i.internal_item_id, quantity=i.quantity,
                           unit_price_minor=i.unit_price_minor) for i in o.items],
            customer_name=o.customer_name, customer_phone=o.customer_phone, notes=o.notes,
            fulfilment_type=o.fulfilment_type)
        res = pos.submit_order(req)  # TransientError propagates -> retry with backoff
        if res.status == "accepted":
            o.pos_state, o.pos_order_id = "delivered", res.pos_order_id
            audit(s, actor="worker", action="pos.delivered", tenant_id=o.tenant_id, entity_type="order",
                  entity_id=o.id, pos_order_id=res.pos_order_id)
        else:
            # Business rejection (e.g. price_mismatch): retrying cannot help. Flag for a human; do not mutate prices.
            o.pos_state, o.pos_reject_code, o.pos_reject_reason = "rejected", res.code, res.reason
            audit(s, actor="worker", action="pos.rejected", tenant_id=o.tenant_id, entity_type="order",
                  entity_id=o.id, code=res.code, reason=res.reason)

    return {"push_status": push_status, "menu_sync": menu_sync, "set_availability": set_availability,
            "deliver_to_pos": deliver_to_pos}
