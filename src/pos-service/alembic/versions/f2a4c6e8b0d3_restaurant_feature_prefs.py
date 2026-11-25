"""restaurants.feature_prefs: the owner's feature switches (order types, bill options, back-office modules).

The restaurant owner can switch off what super admin has granted (app/services/feature_access.py, Manage > Features). A JSON object
{feature code: bool}; a code that is absent is ON, so the default '{}' changes nothing for any existing restaurant.

    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS feature_prefs jsonb NOT NULL DEFAULT '{}'::jsonb

Additive and idempotent: with a constant default Postgres 11+ adds the column without rewriting the table, so it is instant even
with data and safe to re-run. The downgrade drops the column (only the owner's switches are lost).

Revision ID: f2a4c6e8b0d3
Revises: e9b1d3f5a7c2
Create Date: 2026-11-24 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'f2a4c6e8b0d3'
down_revision: Union[str, Sequence[str], None] = 'e9b1d3f5a7c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS feature_prefs jsonb NOT NULL DEFAULT '{}'::jsonb")


def downgrade() -> None:
    op.execute("ALTER TABLE restaurants DROP COLUMN IF EXISTS feature_prefs")
