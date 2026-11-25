"""business_types (one or more of restaurant / cloud_kitchen / hotel_kitchen) on tenants and onboarding applications;
delivery/aggregator catalog features

Revision ID: 0004
Revises: sec0004
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '0004'
down_revision = 'sec0004'
branch_labels = None
depends_on = None

# Non-empty JSON array whose elements are all known types (app/models.py BUSINESS_TYPES_CHECK; dedupe/order is app code).
CHECK = ("case when jsonb_typeof(business_types) = 'array' then jsonb_array_length(business_types) >= 1 "
         "and business_types <@ '[\"restaurant\",\"cloud_kitchen\",\"hotel_kitchen\"]'::jsonb else false end")
TABLES = (('tenants', 'ck_tenant_business_types'), ('onboarding_applications', 'ck_app_business_types'))


def upgrade() -> None:
    for table, ck in TABLES:
        # server_default backfills existing rows as ["restaurant"]
        op.add_column(table, sa.Column('business_types', JSONB(), server_default=sa.text("'[\"restaurant\"]'::jsonb"),
                                       nullable=False))
        # Unreleased earlier draft of this revision used a single `business_type` column: convert it to a one-element array.
        op.execute(f"""do $$ begin
            if exists (select 1 from information_schema.columns where table_name = '{table}' and column_name = 'business_type') then
                update {table} set business_types = jsonb_build_array(business_type);
                alter table {table} drop column business_type;
            end if; end $$""")
        op.create_check_constraint(ck, table, CHECK)
    # Features the business-type entitlement defaults refer to (app/services/entitlements.py). Idempotent: a catalog that
    # already has them (seed script, staff) is left alone.
    op.execute("insert into features (code, name, kind, is_active) values "
               "('delivery', 'Delivery orders', 'flag', true), ('aggregator', 'Aggregator orders', 'flag', true) "
               "on conflict (code) do nothing")


def downgrade() -> None:
    # The delivery/aggregator features stay (plans/overrides/history may reference them).
    for table, ck in reversed(TABLES):
        op.drop_constraint(ck, table, type_='check')
        op.drop_column(table, 'business_types')
