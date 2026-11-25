"""The payload sent to pos-service must validate against pos-service's own DeliveryOrderIn (else every order is a permanent 422)."""
import importlib.util
import pathlib
import uuid

import pytest

from app.pos.client import PosLine, PosOrderRequest
from app.pos.http import HttpPosClient

POS_SCHEMA = pathlib.Path(__file__).resolve().parents[2] / "pos-service" / "app" / "schemas" / "delivery.py"


def _req(**kw):
    base = dict(idempotency_key="zomato:1", tenant_id="t", outlet_id=str(uuid.uuid4()), source="zomato", external_order_id="1",
                currency="INR", lines=[PosLine(internal_item_id=str(uuid.uuid4()), quantity=2, unit_price_minor=5000)], total_minor=10000)
    base.update(kw)
    return PosOrderRequest(**base)


def test_body_fields():
    b = HttpPosClient._body(_req(customer_name=None, outlet_id="outlet-1"))
    assert b["channel"] == "web"
    assert b["address"]["text"] and b["customer"]["name"]
    assert b["outlet_id"] is None  # not a UUID -> default outlet, not a 422


@pytest.mark.skipif(not POS_SCHEMA.exists(), reason="pos-service sources not alongside")
def test_body_validates_against_pos_schema():
    spec = importlib.util.spec_from_file_location("pos_delivery_schema", POS_SCHEMA)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for kw in ({}, {"customer_name": "Asha", "customer_phone": "+919999999999"}, {"customer_name": "  "}, {"outlet_id": "bad"}):
        mod.DeliveryOrderIn.model_validate(HttpPosClient._body(_req(**kw)))
