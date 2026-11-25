"""Indexes for outlet-scoped report queries on large tenants.

Built with CREATE INDEX CONCURRENTLY inside an autocommit block (no write lock on bills / payments during the build).
IF NOT EXISTS makes a retry after a failed (INVALID) build safe only after dropping the invalid index by hand; see docs/REPORTS.md.

Revision ID: c4d8e2a6f0b3
Revises: c2a7e9f1b3d5
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'c4d8e2a6f0b3'
down_revision: Union[str, Sequence[str], None] = 'c2a7e9f1b3d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEXES = (
    ("ix_bills_rest_outlet_sale", "bills", "restaurant_id, outlet_id, sale_at"),
    ("ix_payments_rest_outlet_created", "payments", "restaurant_id, outlet_id, created_at"),
    ("ix_refunds_rest_outlet_created", "refunds", "restaurant_id, outlet_id, created_at"),
    ("ix_orders_rest_outlet_created", "orders", "restaurant_id, outlet_id, created_at"),
)


def upgrade() -> None:
    with op.get_context().autocommit_block():
        for name, table, cols in INDEXES:
            op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} ({cols})")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name, _, _ in INDEXES:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
