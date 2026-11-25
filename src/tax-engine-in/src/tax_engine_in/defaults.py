"""DEFAULT DATA ONLY - every value below is UNVERIFIED and needs CA/accountant sign-off (docs/RULES.md).
Rates are percentages keyed by code; the engine logic never mentions a literal rate."""
from decimal import Decimal

DEFAULT_RATES = {
    "gst_0": Decimal("0"),
    "gst_5": Decimal("5"),
    "gst_12": Decimal("12"),
    "gst_18": Decimal("18"),
    "gst_28": Decimal("28"),
}

# name -> (restaurant_code, collects_tax, itc_eligible, description). See config.Treatment.
DEFAULT_TREATMENTS = {
    "restaurant_5_no_itc": ("gst_5", True, False, "Restaurant service at a concessional rate, no input tax credit"),
    "restaurant_18_with_itc": ("gst_18", True, True, "Restaurant service at the standard rate, with input tax credit"),
    "composition": (None, False, False, "Composition dealer: Bill of Supply, no tax collected"),
    "goods_only": (None, True, True, "No restaurant service; every line carries its own rate (packaged goods)"),
}

DEFAULT_RESTAURANT_SAC = "996331"
