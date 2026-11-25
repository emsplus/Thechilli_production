"""Business types: restaurants.business_types (docs/BUSINESS_TYPES.md).

A JSONB array of one or more of restaurant | cloud_kitchen | hotel_kitchen (owner decision 2026-10-31: a business may select
more than one). Server default ["restaurant"], so every existing restaurant keeps working exactly as before (dine-in, tables,
reservations). A CHECK keeps the value a non-empty array of known types.

Revision ID: a7c3e9f1b2d4
Revises: a6e1d2c3b4f5
Create Date: 2026-10-31 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'a7c3e9f1b2d4'
down_revision: Union[str, Sequence[str], None] = 'a6e1d2c3b4f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""ALTER TABLE restaurants ADD COLUMN business_types JSONB NOT NULL DEFAULT '["restaurant"]'::jsonb""")
    op.execute("""ALTER TABLE restaurants ADD CONSTRAINT ck_restaurants_business_types CHECK (
        jsonb_typeof(business_types) = 'array' AND jsonb_array_length(business_types) >= 1
        AND business_types <@ '["restaurant", "cloud_kitchen", "hotel_kitchen"]'::jsonb)""")


def downgrade() -> None:
    op.execute("ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS ck_restaurants_business_types")
    op.execute("ALTER TABLE restaurants DROP COLUMN IF EXISTS business_types")
