"""platform business_types (one or more of restaurant / cloud_kitchen / hotel_kitchen) on onboarding applications and leads

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

# Non-empty JSON array whose elements are all known types (app/models/enums.py BUSINESS_TYPES_CHECK).
CHECK = ("case when jsonb_typeof(business_types) = 'array' then jsonb_array_length(business_types) >= 1 "
         "and business_types <@ '[\"restaurant\",\"cloud_kitchen\",\"hotel_kitchen\"]'::jsonb else false end")
# descriptive kind (text expression) -> platform type
MAP = "case when {k} in ('cloud_kitchen','hotel_kitchen') then {k} else 'restaurant' end"


def upgrade() -> None:
    op.add_column("onboarding_applications",
                  sa.Column("business_types", JSONB(), server_default=sa.text("'[\"restaurant\"]'::jsonb"), nullable=False))
    op.add_column("leads", sa.Column("business_types", JSONB(), nullable=True))
    # Backfill (canonical order, deduplicated): the lead's kind, then (taking precedence) the checklist business_type item's
    # kinds (`business_type` plus optional `business_types`).
    order = "array_position(array['restaurant','cloud_kitchen','hotel_kitchen'], t)"
    op.execute(f"""update onboarding_applications a set business_types = jsonb_build_array({MAP.format(k='l.business_type')})
                   from leads l where a.lead_id = l.id and l.business_type is not null""")
    op.execute(f"""update onboarding_applications a set business_types = (
                       select jsonb_agg(t order by {order}) from (
                           select distinct {MAP.format(k='k')} as t from (
                               select c.data->>'business_type' as k
                               union all select jsonb_array_elements_text(case when jsonb_typeof(c.data->'business_types') = 'array'
                                                                      then c.data->'business_types' else '[]'::jsonb end)) kinds
                           where k is not null) types)
                   from onboarding_checklist_items c
                   where c.application_id = a.id and c.key = 'business_type' and c.data ? 'business_type'""")
    # Unreleased earlier draft of this revision used a single `business_type` column: convert it to a one-element array.
    op.execute("""do $$ begin
        if exists (select 1 from information_schema.columns
                   where table_name = 'onboarding_applications' and column_name = 'business_type') then
            update onboarding_applications set business_types = jsonb_build_array(business_type);
            alter table onboarding_applications drop column business_type;
        end if; end $$""")
    op.create_check_constraint("ck_app_business_types", "onboarding_applications", CHECK)


def downgrade() -> None:
    op.drop_constraint("ck_app_business_types", "onboarding_applications", type_="check")
    op.drop_column("onboarding_applications", "business_types")
    op.drop_column("leads", "business_types")
