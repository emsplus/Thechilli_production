"""India: the one country this POS serves (owner decision 2026-10-31, docs/DECISIONS.md: India only, all money INR, English
only). Every country / currency / timezone / tax-number fact lives here; money formatting lives in services/money.py.

TODO(CA review): the generic engine (tax_mode 'off') applies the placeholder GST rows below (a single 5% rate, prices
inclusive by default). The CGST/SGST/IGST split, HSN/SAC, place of supply and composition scheme are handled only by the GST
engine (tax_mode 'gst_engine', services/gst.py, docs/GST_INTEGRATION.md). Do not rely on the placeholder figures for returns.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

COUNTRY = "IN"
COUNTRY_NAME = "India"
CURRENCY = "INR"
TIMEZONE = "Asia/Kolkata"
# Display names of time zones (never stored, never used for date maths): clients show these instead of the zone's city, which
# reads wrongly for a restaurant in another city ("Kolkata" for a Bengaluru restaurant, smoke 2026-11-01).
TIMEZONE_LABELS = {"Asia/Kolkata": "India (IST)", "Asia/Calcutta": "India (IST)"}


def timezone_label(tz: str | None) -> str:
    """'India (IST)' for Asia/Kolkata (the only zone this POS serves, docs/INDIA.md). Any other IANA name (an old row, a future
    country) gets the region name and its UTC offset, e.g. 'Asia/Tokyo (UTC+09:00)'; an empty or unknown name gives ''."""
    if not tz:
        return ""
    if tz in TIMEZONE_LABELS:
        return TIMEZONE_LABELS[tz]
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        off = datetime.now(ZoneInfo(tz)).utcoffset()
    except Exception:  # noqa: BLE001 - an unknown zone name: no label rather than an error on a read endpoint
        return ""
    mins = int(off.total_seconds() // 60) if off is not None else 0
    sign = "+" if mins >= 0 else "-"
    return f"{tz.replace('_', ' ')} (UTC{sign}{abs(mins) // 60:02d}:{abs(mins) % 60:02d})"
TAX_NUMBER_LABEL = "GSTIN"
# 2 digit state code (01-38, 97, 99), 10 character PAN, entity number, 'Z', check character
TAX_NUMBER_REGEX = r"^(0[1-9]|[12]\d|3[0-8]|9[79])[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"
TAX_NUMBER_HINT = "15 characters, e.g. 29ABCDE1234F1Z5 (state code, PAN, entity number, Z, check character)"
INVOICE_TITLE = "TAX INVOICE"     # a GST-registered seller's document (registered AND a GSTIN on the bill)
UNREGISTERED_TITLE = "BILL"       # no GSTIN (or not GST registered): a plain bill with no GST lines; never "TAX INVOICE"
PRICES_INCLUDE_TAX = True         # default price mode for new restaurants (editable: PUT /restaurant prices_include_tax)
FISCAL_YEAR_START_MONTH = 4       # April-March invoice series (GST Rule 46)
EAT_IN_ORDER_TYPES = ("indoor", "outdoor")  # consumed on the premises: the service charge applies


@dataclass(frozen=True)
class RateRow:
    code: str
    name: str
    rate_percent: Decimal
    effective_from: date


# Placeholder GST rows of the generic engine (see the module docstring).
RATES: tuple[RateRow, ...] = (
    RateRow("standard", "GST", Decimal("5.00"), date(2017, 7, 1)),
    RateRow("zero", "GST (zero rate)", Decimal("0.00"), date(2017, 7, 1)),
)


def normalise_tax_number(value: str | None) -> str | None:
    """Strips spaces and dashes, upper-cases; '' -> None."""
    if value is None:
        return None
    v = re.sub(r"[\s\-]", "", value).upper()
    return v or None


def tax_number_valid(value: str) -> bool:
    return re.fullmatch(TAX_NUMBER_REGEX, value) is not None


def check_gstin(value: str | None) -> str | None:
    """Normalised GSTIN, None when empty; ValueError (the API's 422) when it is not a GSTIN."""
    v = normalise_tax_number(value)
    if v is not None and not tax_number_valid(v):
        raise ValueError(f"{TAX_NUMBER_LABEL} must be: {TAX_NUMBER_HINT}")
    return v


def seed_rates(db: Session, restaurant) -> dict:
    """Idempotent upsert of India's effective-dated tax_rates rows. Does NOT commit."""
    from app.models.core import TaxRate  # local import: models import this module's constants
    existing = {(t.code, t.effective_from): t for t in db.scalars(select(TaxRate).where(TaxRate.restaurant_id == restaurant.id))}
    added, updated = [], []
    for row in RATES:
        t = existing.get((row.code, row.effective_from))
        if t is None:
            db.add(TaxRate(restaurant_id=restaurant.id, code=row.code, name=row.name,
                           rate_percent=row.rate_percent, effective_from=row.effective_from))
            added.append(f"{row.code}:{row.rate_percent}")
        elif (t.name, t.rate_percent, t.effective_to) != (row.name, row.rate_percent, None):
            t.name, t.rate_percent, t.effective_to = row.name, row.rate_percent, None
            updated.append(f"{row.code}:{row.rate_percent}")
    db.flush()
    return {"added": added, "updated": updated}
