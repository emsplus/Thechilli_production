from decimal import Decimal, InvalidOperation

from fastapi import HTTPException

# code -> (dimension, factor to the dimension's base unit)
UNITS: dict[str, tuple[str, Decimal]] = {
    "g": ("mass", Decimal(1)), "kg": ("mass", Decimal(1000)), "mg": ("mass", Decimal("0.001")),
    "oz": ("mass", Decimal("28.3495")), "lb": ("mass", Decimal("453.592")),
    "ml": ("volume", Decimal(1)), "l": ("volume", Decimal(1000)), "cl": ("volume", Decimal(10)),
    "dl": ("volume", Decimal(100)), "gallon": ("volume", Decimal("4546.09")),  # UK gallon
    "pint": ("volume", Decimal("568.261")),  # UK pint
    "pcs": ("count", Decimal(1)), "dozen": ("count", Decimal(12)),
    "portion": ("count", Decimal(1)),
}
BASE_UNITS = {"g", "ml", "pcs"}

ALIASES = {
    "gm": "g", "gms": "g", "gram": "g", "grams": "g", "kgs": "kg", "kilo": "kg", "kilos": "kg", "kilogram": "kg",
    "kilograms": "kg", "litre": "l", "litres": "l", "liter": "l", "liters": "l", "ltr": "l", "ltrs": "l", "lt": "l",
    "millilitre": "ml", "millilitres": "ml", "centilitre": "cl", "centilitres": "cl", "decilitre": "dl",
    "gal": "gallon", "gallons": "gallon", "pints": "pint", "pt": "pint", "ounce": "oz", "ounces": "oz", "lbs": "lb",
    "pound": "lb", "pounds": "lb", "piece": "pcs", "pieces": "pcs", "pc": "pcs", "nos": "pcs", "each": "pcs",
    "unit": "pcs", "units": "pcs", "doz": "dozen", "dozens": "dozen", "portions": "portion", "prtn": "portion",
    "prtns": "portion", "prt": "portion", "port": "portion", "ptn": "portion",
}


def normalize_code(code: str) -> str:
    c = code.strip().lower().rstrip(".")
    return ALIASES.get(c, c)


def to_base(quantity: Decimal, unit: str, base_unit: str) -> Decimal:
    """Convert to the item's base unit. Cross-dimension conversion (e.g. kg -> ml) is rejected."""
    u, b = UNITS.get(normalize_code(unit)), UNITS.get(base_unit)
    if u is None:
        raise HTTPException(422, f"Unknown unit '{unit}'")
    if b is None or u[0] != b[0]:
        raise HTTPException(422, f"Cannot convert '{unit}' to '{base_unit}'")
    try:
        return (quantity * u[1] / b[1]).quantize(Decimal("0.001"))
    except InvalidOperation:  # far beyond any real stock quantity (it used to be a 500)
        raise HTTPException(422, "That quantity is too large")


def item_factor(db, item, unit: str) -> Decimal:
    """Base units per 1 `unit` for this item: its own conversion (1 case = 24 pcs) first, else the global unit table
    (cross-dimension conversion is refused)."""
    from sqlalchemy import select
    from app.models.inventory import ItemUnitConversion
    code = normalize_code(unit)
    f = db.scalar(select(ItemUnitConversion.factor_to_base).where(
        ItemUnitConversion.item_id == item.id, ItemUnitConversion.unit_code == code))
    if f is not None:
        return Decimal(f)
    return to_base(Decimal(1), unit, item.base_unit) if code != item.base_unit else Decimal(1)


def to_base_item(db, item, quantity: Decimal, unit: str) -> Decimal:
    """Like `to_base` but honours the item's own unit conversions. Rounded to the ledger's 3 decimals."""
    return (quantity * item_factor(db, item, unit)).quantize(Decimal("0.001"))
