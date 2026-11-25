"""The business type (restaurant / cloud kitchen / hotel kitchen) is changed only by platform staff, never by the owner (2026-11-25)."""
import os

os.environ.setdefault("ENV", "development")

import pytest

from app.api.v1 import provision, restaurant
from app.schemas.common import BusinessTypesIn
from app.services.entitlements import EntitlementError


def test_owner_cannot_change_the_business_type():
    with pytest.raises(EntitlementError) as e:
        restaurant.set_business_types(BusinessTypesIn(business_types=["cloud_kitchen"]), p=None, db=None)
    assert e.value.status_code == 403 and e.value.code == "business_type_locked"


def test_platform_staff_route_is_still_there():
    paths = {(r.path, m) for r in provision.router.routes for m in getattr(r, "methods", ())}
    assert any(p.endswith("/tenants/{tenant_id}/business-types") and m == "PUT" for p, m in paths)
