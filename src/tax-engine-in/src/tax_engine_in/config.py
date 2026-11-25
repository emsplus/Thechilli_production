from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from types import MappingProxyType
from typing import Mapping

from .defaults import DEFAULT_RATES, DEFAULT_RESTAURANT_SAC, DEFAULT_TREATMENTS
from .errors import TaxError
from .validation import (
    normalise_state_code,
    strict_decimal,
    validate_gstin,
    validate_hsn_sac,
)

NO_TAX = "none"  # reserved code: composition / not collecting tax. Rate is always 0.


@dataclass(frozen=True)
class Treatment:
    name: str
    restaurant_code: str | None     # rate code applied to supply_type="restaurant" lines
    collects_tax: bool = True       # False => composition scheme: Bill of Supply, zero tax everywhere
    itc_eligible: bool = False      # informational flag for the caller (does not change the calculation)
    description: str = ""


def default_treatments() -> dict[str, Treatment]:
    return {n: Treatment(n, c, t, i, d) for n, (c, t, i, d) in DEFAULT_TREATMENTS.items()}


@dataclass(frozen=True)
class TaxConfig:
    seller_state: str                                   # 2-digit GST state code, e.g. "29"
    treatment: str = "restaurant_5_no_itc"
    rates: Mapping[str, Decimal] = field(default_factory=lambda: dict(DEFAULT_RATES))
    treatments: Mapping[str, Treatment] = field(default_factory=default_treatments)
    restaurant_sac: str = DEFAULT_RESTAURANT_SAC
    seller_gstin: str | None = None

    def __post_init__(self) -> None:
        try:
            object.__setattr__(self, "seller_state", normalise_state_code(self.seller_state))
            object.__setattr__(self, "restaurant_sac", validate_hsn_sac(self.restaurant_sac))
            if self.seller_gstin is not None:
                g = validate_gstin(self.seller_gstin)
                if g[:2] != self.seller_state:
                    raise TaxError("seller_gstin state code does not match seller_state")
                object.__setattr__(self, "seller_gstin", g)
        except TaxError as e:
            raise TaxError(f"Invalid seller configuration: {e}", 409) from None
        rates: dict[str, Decimal] = {}
        for code, r in self.rates.items():
            try:
                rate = strict_decimal(r, "rate")
            except TaxError:
                raise TaxError(f"Invalid rate config for '{code}'", 409) from None
            if code == NO_TAX or not (Decimal(0) <= rate < Decimal(100)):
                raise TaxError(f"Invalid rate config for '{code}'", 409)
            rates[code] = rate
        # Immutable after validation: private copies behind read-only views (the caller's dicts stay theirs).
        object.__setattr__(self, "rates", MappingProxyType(rates))
        object.__setattr__(self, "treatments", MappingProxyType(dict(self.treatments)))
        if self.treatment not in self.treatments:
            raise TaxError(f"Unknown treatment '{self.treatment}'", 409)
        t = self.treatments[self.treatment]
        if t.restaurant_code is not None and t.restaurant_code not in self.rates:
            raise TaxError(f"Treatment '{t.name}' uses unknown rate code '{t.restaurant_code}'", 409)

    @property
    def active(self) -> Treatment:
        return self.treatments[self.treatment]

    def rate(self, code: str) -> Decimal:
        if code == NO_TAX:
            return Decimal(0)
        if code not in self.rates:
            raise TaxError(f"No tax rate configured for code '{code}'", 409)
        return self.rates[code]
