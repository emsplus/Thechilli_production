"""One modifier group on many dishes at once (POST /menu/modifier-groups/{id}/apply). Needs a migrated Postgres (DATABASE_URL); skipped
when none answers. Runs the real API with TestClient."""
import os
import uuid

import pytest

os.environ.setdefault("ENV", "development")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402


def _client():
    try:
        from app.core.db import engine
        with engine.connect() as c:
            c.execute(text("select 1"))
    except Exception:
        pytest.skip("no migrated Postgres reachable via DATABASE_URL")
    from app.main import app
    return TestClient(app)


@pytest.fixture()
def shop(monkeypatch):
    c = _client()
    from app.core.config import settings
    monkeypatch.setattr(settings, "signup_email_verification", False)       # sign-up answers 201 with a session (no e-mail OTP step)
    monkeypatch.setattr(settings, "register_per_ip_per_hour", 100_000)      # many sign-ups from one test machine
    monkeypatch.setattr(settings, "register_global_per_hour", 100_000)
    pw = "Test-" + uuid.uuid4().hex[:12] + "!aZ9"
    email = f"apply-{uuid.uuid4().hex[:8]}@example.in"
    r = c.post("/api/v1/auth/register-restaurant", json={"restaurant_name": "Apply Test", "country": "IN", "owner_email": email,
                                                         "owner_name": "Apply Owner", "owner_password": pw})
    assert r.status_code == 201, r.text
    tok = r.json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    cats = {}
    for name in ("Rolls", "Drinks"):
        cats[name] = c.post("/api/v1/menu/categories", json={"name": name}, headers=h).json()["id"]
    items = {}
    for cat, names in (("Rolls", ["Roll A", "Roll B", "Roll C"]), ("Drinks", ["Cola"])):
        for n in names:
            items[n] = c.post("/api/v1/menu/items", json={"category_id": cats[cat], "name": n, "price": "100"}, headers=h).json()["id"]
    return c, h, cats, items


def _group(c, h, name="Add on"):
    r = c.post("/api/v1/menu/modifier-groups", headers=h, json={"name": name, "min_select": 0, "max_select": None, "options": [
        {"name": "Cheese", "price_delta_paise": 2000}, {"name": "Egg", "price_delta_paise": 1000}]})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _on(c, h, gid):
    return {i for g in c.get("/api/v1/menu/modifier-groups", headers=h).json() if g["id"] == gid for i in g["item_ids"]}


def test_category_scope_attaches_only_that_category_and_is_idempotent(shop):
    c, h, cats, items = shop
    gid = _group(c, h)
    r = c.post(f"/api/v1/menu/modifier-groups/{gid}/apply", headers=h, json={"mode": "attach", "category_ids": [cats["Rolls"]]})
    assert r.status_code == 200 and r.json() == {"changed": 3, "total": 3}
    assert _on(c, h, gid) == {items["Roll A"], items["Roll B"], items["Roll C"]}
    again = c.post(f"/api/v1/menu/modifier-groups/{gid}/apply", headers=h, json={"mode": "attach", "category_ids": [cats["Rolls"]]})
    assert again.json() == {"changed": 0, "total": 3}  # nothing new


def test_all_items_then_detach_and_other_groups_keep_their_order(shop):
    c, h, cats, items = shop
    first, second = _group(c, h, "Spice"), _group(c, h, "Add on")
    c.put(f"/api/v1/menu/items/{items['Roll A']}/modifier-groups", headers=h, json={"group_ids": [first]})
    r = c.post(f"/api/v1/menu/modifier-groups/{second}/apply", headers=h, json={"mode": "attach", "all_items": True})
    assert r.json() == {"changed": 4, "total": 4}
    # Roll A keeps "Spice" first and gets the new group after it
    ga = [g["id"] for g in c.get("/api/v1/menu/modifier-groups", headers=h).json() if items["Roll A"] in g["item_ids"]]
    assert set(ga) == {first, second}
    d = c.post(f"/api/v1/menu/modifier-groups/{second}/apply", headers=h, json={"mode": "detach", "category_ids": [cats["Drinks"]]})
    assert d.json() == {"changed": 1, "total": 1}
    assert _on(c, h, second) == {items["Roll A"], items["Roll B"], items["Roll C"]}
    assert _on(c, h, first) == {items["Roll A"]}


def test_needs_a_scope_and_a_category_of_this_restaurant(shop):
    c, h, cats, items = shop
    gid = _group(c, h)
    assert c.post(f"/api/v1/menu/modifier-groups/{gid}/apply", headers=h, json={"mode": "attach"}).status_code == 422
    assert c.post(f"/api/v1/menu/modifier-groups/{gid}/apply", headers=h,
                  json={"mode": "attach", "category_ids": [str(uuid.uuid4())]}).status_code == 404
    assert c.post(f"/api/v1/menu/modifier-groups/{uuid.uuid4()}/apply", headers=h, json={"mode": "attach", "all_items": True}).status_code == 404


def test_a_group_created_with_no_limit_stays_unlimited(shop):
    """max_select null ("Empty = no limit" in the editor) used to become 1 on CREATE (column default); update kept null."""
    c, h, cats, items = shop
    body = {"name": "Add on", "min_select": 0, "max_select": None, "options": [{"name": "Cheese", "price_delta_paise": 2000}]}
    r = c.post("/api/v1/menu/modifier-groups", headers=h, json=body)
    assert r.status_code == 201 and r.json()["max_select"] is None
    assert [g["max_select"] for g in c.get("/api/v1/menu/modifier-groups", headers=h).json()] == [None]
