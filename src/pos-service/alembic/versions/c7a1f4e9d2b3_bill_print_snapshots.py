"""bill print snapshots (customer, table, order type, cashier)

Revision ID: c7a1f4e9d2b3
Revises: b85e35c4d43c
Create Date: 2026-10-25 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c7a1f4e9d2b3'
down_revision: Union[str, Sequence[str], None] = 'b85e35c4d43c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # All nullable: bills finalized before this migration keep rendering (live lookups, else the line is omitted).
    op.add_column('bills', sa.Column('customer_name', sa.String(length=200), nullable=True))
    op.add_column('bills', sa.Column('customer_phone', sa.String(length=20), nullable=True))
    op.add_column('bills', sa.Column('table_label', sa.String(length=50), nullable=True))
    op.add_column('bills', sa.Column('order_type', sa.String(length=20), nullable=True))
    op.add_column('bills', sa.Column('cashier_name', sa.String(length=200), nullable=True))


def downgrade() -> None:
    for c in ('cashier_name', 'order_type', 'table_label', 'customer_phone', 'customer_name'):
        op.drop_column('bills', c)
