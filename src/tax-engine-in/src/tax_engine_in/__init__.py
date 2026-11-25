"""Deterministic India GST engine for restaurant billing. All rules UNVERIFIED: see docs/RULES.md."""
from .config import NO_TAX, TaxConfig, Treatment, default_treatments
from .credit import CreditNote, credit_note_amount, credit_note_fraction, credit_note_items
from .engine import compute_invoice, discount_percent_of, item_total, validate_discount
from .errors import TaxError
from .models import ChargeIn, DiscountIn, Invoice, LineIn, LineOut
from .rounding import allocate, from_minor, round_half_up, to_minor
from .numbering import document_number, financial_year
from .summary import HsnRow, RateRow, breakup_by_rate, hsn_summary
from .validation import normalise_state_code, validate_gstin, validate_hsn_sac

__all__ = [n for n in dir() if not n.startswith("_")]
