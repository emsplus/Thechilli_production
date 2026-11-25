"""India only, INR only (owner decision 2026-10-31, docs/DECISIONS.md): convert every remaining non-India restaurant / outlet,
relabel historic money rows as INR / IN, and let the database itself refuse any other currency or country.

1. restaurants and outlets whose country / currency / timezone is not IN / INR / Asia/Kolkata become IN / INR /
   Asia/Kolkata (the decisions of the former operator script convert_restaurant_to_india.py, applied to every such row):
   * tax_mode: 'off' (the generic engine), unless the row is already on 'gst_engine' WITH a gst_config (the engine needs
     one; it validates the GSTIN when the owner saves the GST settings).
   * prices_include_tax is KEPT as it is (unlike the operator script, which set India's default, inclusive). Flipping it
     in bulk would silently change what every customer pays for every menu price; both modes are valid in India and the
     owner can change it in the settings.
   * tax rows: India's placeholder rows ('GST' 5% standard, 'GST (zero rate)' 0%, services/localisation.py RATES) are
     ADDED, effective from the day of this migration, for each converted restaurant. Older rows are NOT deleted or edited:
     the newest row per code wins from today, and a correction of an old bill still finds the rate of its own sale date.
   * trn (the tax number) is kept; it holds the GSTIN from now on and is validated as one on the next save. One
     audit_logs row per converted restaurant records the old values ('restaurant.convert_india', no user).
2. Money labels: bills (currency, country) and online_payments (currency) rows with another value are relabelled INR / IN.
   Amounts and tax snapshots are NOT touched: the numbers stay exactly as issued, only the label changes, so nothing can
   ever show a non-INR currency. (Stored Z-report snapshots are relabelled when read, services/zreport.stored_out.)
3. CHECK constraints: currency = 'INR' on restaurants, outlets, bills, online_payments; country = 'IN' on restaurants,
   outlets, bills. Server defaults stay INR / IN / Asia/Kolkata (revision f1a2b3c4d5e6).

Downgrade drops the constraints only. The relabelling and the conversion are ONE-WAY (the old labels are not kept,
except in the audit_logs rows of step 1).

Revision ID: 7c3e9a1f5b2d
Revises: f1a2b3c4d5e6
Create Date: 2026-11-01 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = '7c3e9a1f5b2d'
down_revision: Union[str, Sequence[str], None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def not_india(alias: str = "") -> str:
    a = f"{alias}." if alias else ""
    return f"({a}country <> 'IN' OR {a}currency <> 'INR' OR {a}timezone <> 'Asia/Kolkata')"


CHECKS = [  # (table, constraint, condition)
    ("restaurants", "ck_restaurants_currency_inr", "currency = 'INR'"),
    ("restaurants", "ck_restaurants_country_in", "country = 'IN'"),
    ("outlets", "ck_outlets_currency_inr", "currency = 'INR'"),
    ("outlets", "ck_outlets_country_in", "country = 'IN'"),
    ("bills", "ck_bills_currency_inr", "currency = 'INR'"),
    ("bills", "ck_bills_country_in", "country = 'IN'"),
    ("online_payments", "ck_online_payments_currency_inr", "currency = 'INR'"),
]


def upgrade() -> None:
    # 1. restaurants: audit row with the old values, India tax rows from today, then the conversion itself
    op.execute(f"""
        INSERT INTO audit_logs (id, restaurant_id, user_id, action, entity, entity_id, detail, created_at)
        SELECT gen_random_uuid(), r.id, NULL, 'restaurant.convert_india', 'restaurant', r.id::text,
               json_build_object('source', 'migration 7c3e9a1f5b2d',
                                 'old', json_build_object('country', r.country, 'currency', r.currency, 'timezone', r.timezone,
                                                          'tax_mode', r.tax_mode, 'trn', r.trn,
                                                          'prices_include_tax', r.prices_include_tax),
                                 'new', json_build_object('country', 'IN', 'currency', 'INR', 'timezone', 'Asia/Kolkata')),
               now()
        FROM restaurants r WHERE {not_india('r')}
    """)
    op.execute(f"""
        INSERT INTO tax_rates (id, restaurant_id, code, name, rate_percent, effective_from, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, v.code, v.name, v.rate, CURRENT_DATE, now(), now()
        FROM restaurants r
        CROSS JOIN (VALUES ('standard', 'GST', 5.00), ('zero', 'GST (zero rate)', 0.00)) AS v(code, name, rate)
        WHERE {not_india('r')}
        ON CONFLICT (restaurant_id, code, effective_from) DO NOTHING
    """)
    op.execute(f"""
        UPDATE restaurants SET country = 'IN', currency = 'INR', timezone = 'Asia/Kolkata',
               tax_mode = CASE WHEN tax_mode = 'gst_engine' AND gst_config IS NOT NULL THEN tax_mode ELSE 'off' END
        WHERE {not_india()}
    """)
    op.execute(f"UPDATE outlets SET country = 'IN', currency = 'INR', timezone = 'Asia/Kolkata' WHERE {not_india()}")
    # 2. labels only: amounts and tax snapshots keep their numbers
    op.execute("UPDATE bills SET currency = 'INR' WHERE currency <> 'INR'")
    op.execute("UPDATE bills SET country = 'IN' WHERE country <> 'IN'")
    op.execute("UPDATE online_payments SET currency = 'INR' WHERE currency <> 'INR'")
    # 3. the database refuses anything else from now on
    for table, name, cond in CHECKS:
        op.create_check_constraint(name, table, cond)


def downgrade() -> None:
    for table, name, _ in reversed(CHECKS):
        op.drop_constraint(name, table, type_="check")
