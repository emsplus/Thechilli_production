import httpx

from app.core.config import settings
from app.core.security import resolve_secret
from app.pos.base import IdempotencyConflict, PosClient, PosRejected, PosUnavailable, PriceChanged


class HttpPosClient(PosClient):
    """Server-to-server client for the contract in docs/DELIVERY_EXTRACTION_PLAN.md section 5.
    `api_key_ref` is the NAME of an env var holding the per-restaurant service credential."""

    def __init__(self, api_key_ref: str, transport: httpx.BaseTransport | None = None):
        self.api_key_ref = api_key_ref
        self._transport = transport

    def _call(self, method: str, path: str, restaurant_id: str, *, json=None, params=None, headers=None):
        h = {"Authorization": f"Bearer {resolve_secret(self.api_key_ref)}", "X-Restaurant-ID": restaurant_id,
             **(headers or {})}
        try:
            with httpx.Client(base_url=settings.pos_base_url, timeout=settings.pos_timeout_seconds,
                              transport=self._transport) as c:
                r = c.request(method, "/api/v1/delivery" + path, json=json, params=params, headers=h)
        except httpx.HTTPError as e:
            raise PosUnavailable(str(e)) from e
        if r.status_code >= 500:
            raise PosUnavailable(f"pos {r.status_code}")
        return r

    @staticmethod
    def _json(r: httpx.Response) -> dict:
        try:
            body = r.json()
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}

    @classmethod
    def _ok(cls, r: httpx.Response) -> dict:
        if r.status_code >= 400:
            body = cls._json(r)
            err = body.get("error")
            code = body.get("code") or (err.get("code") if isinstance(err, dict) else None) or "rejected"
            raise PosRejected(str(body)[:300], status=r.status_code, code=code)
        return r.json() if r.content else {}

    def get_menu(self, restaurant_id, outlet_id=None):
        return self._ok(self._call("GET", "/menu", restaurant_id,
                                   params={"restaurant_id": restaurant_id, "outlet_id": outlet_id or ""}))

    def get_config(self, restaurant_id, outlet_id=None):
        return self._ok(self._call("GET", "/config", restaurant_id,
                                   params={"restaurant_id": restaurant_id, "outlet_id": outlet_id or ""}))

    def create_order(self, restaurant_id, idempotency_key, body):
        r = self._call("POST", "/orders", restaurant_id, json=body, headers={"Idempotency-Key": idempotency_key})
        data = self._json(r)
        if r.status_code == 409 and data.get("code") == "price_changed":
            raise PriceChanged(data.get("lines", []))
        if r.status_code == 422 and data.get("code") == "idempotency_conflict":
            raise IdempotencyConflict()
        return self._ok(r)

    def get_order(self, restaurant_id, order_id):
        return self._ok(self._call("GET", f"/orders/{order_id}", restaurant_id))

    def cancel_order(self, restaurant_id, order_id, reason):
        self._ok(self._call("POST", f"/orders/{order_id}/cancel", restaurant_id, json={"reason": reason}))

    def dispatch(self, restaurant_id, order_id):
        self._ok(self._call("POST", f"/orders/{order_id}/dispatch", restaurant_id))

    def delivered(self, restaurant_id, order_id):
        self._ok(self._call("POST", f"/orders/{order_id}/delivered", restaurant_id))
