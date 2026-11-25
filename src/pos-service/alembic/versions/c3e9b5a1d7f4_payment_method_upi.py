"""payment_method enum: + 'upi' (existing rows unchanged)

Revision ID: c3e9b5a1d7f4
Revises: c1d7a3e9f5b2
Create Date: 2026-10-31 09:10:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'c3e9b5a1d7f4'
down_revision: Union[str, Sequence[str], None] = 'c1d7a3e9f5b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'upi'")


def downgrade() -> None:
    pass  # an enum value cannot be dropped safely; rows using it would have to be rewritten first
