import copy
import itertools

from app.pos.base import IdempotencyConflict, PosClient, PosRejected, PosUnavailable, PriceChanged

DEFAULT_MENU = {
    "menu_version": "v1", "currency": "INR",
    "categories": [{"id": "c1", "name": "Mains"}],
    "items": [
        {"id": "i1", "name": "Paneer Tikka", "price": 25000, "currency": "INR", "is_active": True, "variants": [],
         "description": "Smoky", "food_type": "veg", "image_url": None, "sort_order": 1, "category_id": "c1"},
        {"id": "i2", "name": "Naan", "price": 5000, "currency": "INR", "is_active": True, "variants": [],
         "description": "", "food_type": "veg", "image_url": None, "sort_order": 2, "category_id": "c1"},
        {"id": "i3", "name": "Sold out thing", "price": 9900, "currency": "INR", "is_active": False,
         "variants": [], "description": "", "food_type": "veg", "image_url": None, "sort_order": 3,
         "category_id": "c1"},
    ]}


class FakePosClient(PosClient):
    """In-memory stand-in implementing the POS contract: server-side price recompute, idempotency by key
    (replay -> same order, different body -> IdempotencyConflict), (order, status)-idempotent dispatch/delivered."""

    def __init__(self, delivery_fee=3000, min_order=0, **config):
        self.extra_config = config  # e.g. outlet_lat, outlet_lng, delivery_radius_km, allow_cod, allow_online
        self.menu = copy.deepcopy(DEFAULT_MENU)
        self.delivery_fee = delivery_fee
        self.min_order = min_order
        self.orders: dict[str, dict] = {}
        self.keys: dict[tuple, tuple[dict, dict]] = {}
        self.calls: list[tuple] = []
        self.status_calls: set[tuple] = set()
        self.down = False  # simulate outage
        self.auto_accept = False  # POS with accept_before_kot off: accepted inside the create call (answers version 2)
        self._n = itertools.count(1)

    def _guard(self, name, *a):
        self.calls.append((name, *a))
        if self.down:
            raise PosUnavailable("fake pos down")

    def set_price(self, item_id, price):
        for i in self.menu["items"]:
            if i["id"] == item_id:
                i["price"] = price
        self.menu["menu_version"] += "x"

    def get_menu(self, restaurant_id, outlet_id=None):
        self._guard("get_menu", restaurant_id)
        return copy.deepcopy(self.menu)

    def get_config(self, restaurant_id, outlet_id=None):
        self._guard("get_config", restaurant_id)
        return {"delivery_fee": self.delivery_fee, "min_order": self.min_order, "currency": "INR", **self.extra_config}

    def create_order(self, restaurant_id, idempotency_key, body):
        self._guard("create_order", restaurant_id, idempotency_key)
        k = (restaurant_id, idempotency_key)
        if k in self.keys:
            old_body, resp = self.keys[k]
            if old_body != body:
                raise IdempotencyConflict()
            return dict(resp)
        items = {i["id"]: i for i in self.menu["items"]}
        subtotal, changed = 0, []
        for ln in body["lines"]:
            it = items.get(ln["item_id"])
            if not it or not it["is_active"]:
                raise PosRejected(f"item {ln['item_id']} unavailable", code="item_unavailable")
            if ln["quantity"] < 1:
                raise PosRejected("bad quantity")
            unit = it["price"]
            if ln.get("variant_id"):  # like POS: the variant's price replaces the item price; an unknown one is unavailable
                v = next((v for v in it["variants"] if v["id"] == ln["variant_id"] and v.get("is_active", True)), None)
                if v is None:
                    raise PosRejected(f"option {ln['variant_id']} unavailable", code="item_unavailable")
                unit = v["price"]
            if unit != ln["expected_unit_price"]:
                changed.append({"item_id": it["id"], "new_price": unit})
            subtotal += unit * ln["quantity"]
        if changed:
            raise PriceChanged(changed)
        if subtotal < self.min_order:
            raise PosRejected("below minimum order", code="below_min_order")
        tax = subtotal * 5 // 100
        n = next(self._n)
        resp = {"order_id": f"pos-{n}", "order_code": f"D{n:04d}", "subtotal": subtotal,
                "delivery_fee": self.delivery_fee, "tax": tax, "total": subtotal + tax + self.delivery_fee,
                "status": "placed", "version": 1}
        if self.auto_accept:
            resp.update(status="accepted", version=2)
        self.keys[k] = (copy.deepcopy(body), resp)
        self.orders[resp["order_id"]] = {**resp, "restaurant_id": restaurant_id, "body": body}
        return dict(resp)

    def get_order(self, restaurant_id, order_id):
        self._guard("get_order", restaurant_id, order_id)
        o = self.orders.get(order_id)
        if not o or o["restaurant_id"] != restaurant_id:
            raise PosRejected("not found", status=404, code="not_found")
        return {k: v for k, v in o.items() if k != "body"}

    def cancel_order(self, restaurant_id, order_id, reason):
        self._guard("cancel_order", restaurant_id, order_id)
        self.orders[order_id]["status"] = "cancelled"

    def dispatch(self, restaurant_id, order_id):
        self._guard("dispatch", restaurant_id, order_id)
        self.status_calls.add((order_id, "out_for_delivery"))

    def delivered(self, restaurant_id, order_id):
        self._guard("delivered", restaurant_id, order_id)
        self.status_calls.add((order_id, "delivered"))
