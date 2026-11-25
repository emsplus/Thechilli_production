"""Severity of the Leakage report's payment flags, in ONE place (docs/REPORTS.md, "Leakage severities").

An unpaid bill that is simply waiting for payment is information, not an alarm: it only gets more serious with age. A payment
difference is only serious when money is really missing, i.e. the part of "payments minus takings" that the unpaid bills do not
explain. Pure functions, no database: the matrix is unit-tested on its own (tests/test_tester_bugs_leakage.py).
"""
from datetime import timedelta
from decimal import Decimal

LOW, MEDIUM, HIGH = "low", "medium", "high"

UNPAID_MEDIUM_AFTER = timedelta(hours=2)   # unpaid for more than 2 hours, or past the end of its business day -> medium
UNPAID_HIGH_AFTER = timedelta(days=3)      # still unpaid after 3 days -> high

MISSING_MEDIUM = Decimal(5)                # money that really is missing (not explained by unpaid bills) ...
MISSING_HIGH = Decimal(50)                 # ... medium from this much, high from this much (INR)


def unpaid_bill_severity(age: timedelta, past_business_day: bool) -> str:
    """age: now - the bill's sale time. past_business_day: the sale's local (restaurant timezone) date is before today's."""
    if age >= UNPAID_HIGH_AFTER:
        return HIGH
    if age > UNPAID_MEDIUM_AFTER or past_business_day:
        return MEDIUM
    return LOW


def worst(severities) -> str | None:
    order = {HIGH: 0, MEDIUM: 1, LOW: 2}
    return min(severities, key=order.__getitem__, default=None)


def missing_money(difference: Decimal, outstanding: Decimal) -> Decimal:
    """The part of the Z-check difference (payments - takings) that unpaid bills do not explain. Takings count a bill when it is
    billed, payments when they are taken, so an unpaid bill makes the difference negative by its balance; depending on how the day
    report books unpaid bills the difference is either -outstanding (explained) or 0, so the smaller reading is the unexplained one."""
    return min(abs(difference), abs(difference + outstanding))


def payment_difference_severity(missing: Decimal) -> str | None:
    """None = nothing to flag."""
    missing = abs(missing)
    if missing >= MISSING_HIGH:
        return HIGH
    if missing >= MISSING_MEDIUM:
        return MEDIUM
    return None
