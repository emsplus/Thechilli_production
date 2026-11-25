import pytest
from pydantic import ValidationError

from app.api.routes import MenuMapIn


def test_menu_mapping_rejects_oversized_and_empty_ids():
    ok = dict(outlet_id="o1", provider="mock", external_item_id="e1", internal_item_id="i1")
    assert MenuMapIn(**ok)
    for field, n in (("outlet_id", 65), ("provider", 33), ("external_item_id", 129), ("internal_item_id", 65)):
        with pytest.raises(ValidationError):
            MenuMapIn(**{**ok, field: "x" * n})
    with pytest.raises(ValidationError):
        MenuMapIn(**{**ok, "internal_item_id": ""})
