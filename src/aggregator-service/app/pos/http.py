"""HttpPosClient: server-to-server client for pos-service's delivery endpoints, reusing the contract in
docs/DELIVERY_EXTRACTION_PLAN.md section 5 and delivery-service/app/pos/http.py (POST /api/v1/delivery/orders with an
Idempotency-Key; 409 price_changed; 422 idempotency_conflict; per-restaurant service credential).

Mapping to our model: the tenant is the pos restaurant (X-Restaurant-ID); the credential is the env var
AGG_SECRET_<TENANT>__POS_API_KEY (never stored in the DB). pos-service recomputes every price, fee and tax and is
never trusted to accept ours; business refusals come back as PosResult(status="rejected"), outages as TransientError."""
import uuid

import httpx

from app.core.config import settings
from app.core.security import resolve_secret, tenant_secret_prefix
from app.pos.client import PosOrderRequest, PosResult
from app.providers.base import TransientError

_TRANSIENT = {408, 425, 429}
_AUTH = {401, 403}  # misconfigured credential: retryable once an operator fixes it, never a business rejection


def _json(r: httpx.Response) -> dict:
    try:
        d = r.json()
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def _code(body: dict, default: str) -> str:
    err = body.get("error")
    return str(body.get("code") or (err.get("code") if isinstance(err, dict) else None) or default)


class HttpPosClient:
    def __init__(self, transport: httpx.BaseTransport | None = None):
        self._transport = transport

    def _headers(self, req: PosOrderRequest) -> dict:
        ref = tenant_secret_prefix(req.tenant_id) + "POS_API_KEY"
        try:
            key = resolve_secret(ref, req.tenant_id)
        except Exception as e:
            raise TransientError(f"pos credential {ref} unavailable") from e
        return {"Authorization": f"Bearer {key}", "X-Restaurant-ID": req.tenant_id,
                "Idempotency-Key": req.idempotency_key}

    @staticmethod
    def _outlet(raw: str | None) -> str | None:
        """pos-service takes a UUID (or none = the default outlet); a non-UUID id would be a 422 for every order."""
        try:
            return str(uuid.UUID(str(raw)))
        except (ValueError, AttributeError, TypeError):
            return None

    @staticmethod
    def _body(req: PosOrderRequest) -> dict:
        # Shaped for pos-service's DeliveryOrderIn: channel only allows "whatsapp" | "web" (the marketplace stays in `source`),
        # and customer name / address text must be non-empty (a marketplace order carries no street address of ours).
        return {
            "client_uuid": req.idempotency_key, "channel": "web", "order_type": req.fulfilment_type,
            "source": req.source, "external_order_id": req.external_order_id, "outlet_id": HttpPosClient._outlet(req.outlet_id),
            "customer": {"name": (req.customer_name or "").strip() or f"{req.source} customer", "wa_number": req.customer_phone},
            "address": {"text": f"{req.source} order {req.external_order_id}"[:500], "lat": None, "lng": None},
            # paid at the marketplace: still only a CLAIM, never treated as paid until pos-service confirms
            "payment": {"mode": "online", "claimed_paid": False, "ref": None},
            "promo_code": None, "notes": req.notes,
            "lines": [{"item_id": ln.internal_item_id, "variant_id": None, "quantity": ln.quantity, "note": "",
                       "expected_unit_price": ln.unit_price_minor} for ln in req.lines]}

    def submit_order(self, req: PosOrderRequest) -> PosResult:
        if not settings.pos_base_url:
            raise TransientError("POS_BASE_URL is not configured")
        headers = self._headers(req)
        try:
            with httpx.Client(base_url=settings.pos_base_url, timeout=settings.pos_timeout_seconds,
                              transport=self._transport) as c:
                r = c.post("/api/v1/delivery/orders", json=self._body(req), headers=headers)
        except httpx.HTTPError as e:
            raise TransientError(f"pos unreachable: {type(e).__name__}") from e
        if r.status_code >= 500 or r.status_code in _TRANSIENT:
            raise TransientError(f"pos {r.status_code}")
        if r.status_code in _AUTH:
            raise TransientError(f"pos refused our credential ({r.status_code})")
        body = _json(r)
        if r.status_code in (200, 201):  # 200 = replay of the same key: same order, so safe either way
            oid = body.get("order_id")
            if not oid:
                raise TransientError("pos accepted without an order_id")
            return PosResult(status="accepted", pos_order_id=str(oid))
        if r.status_code == 409 and body.get("code") == "price_changed":
            return PosResult(status="rejected", code="price_mismatch", reason=str(body.get("lines", []))[:500])
        # 422 idempotency_conflict, item_unavailable, below_min_order, 404 ...: a retry cannot change the answer
        return PosResult(status="rejected", code=_code(body, f"http_{r.status_code}"),
                         reason=(str(body.get("message") or body.get("detail") or body)[:500]))
