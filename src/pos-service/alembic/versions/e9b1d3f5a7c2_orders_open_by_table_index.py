"""Partial index for the one-open-order-per-table check (BREAK_BACKEND_REPORT.md P3).

`order_rules.open_order_on_table` / `refuse_second_order` (every dine-in order create, under the table row lock), `GET /tables/status`
(polled by the waiter app) and the table deactivation guard all ask "which open / sent_to_kitchen orders does this table have?". With
only an index on (restaurant, outlet, created_at) that was a sequential scan of `orders`, growing with the whole history (50,000
orders: 6.9 ms and growing linearly). The partial index holds only the rows that are open right now (a handful per outlet), so the
lookup is constant and the index itself stays tiny whatever the history.

    CREATE INDEX IF NOT EXISTS ix_orders_open_by_table ON orders (table_id) WHERE status IN ('open', 'sent_to_kitchen')

Additive and idempotent (IF NOT EXISTS / IF EXISTS): safe on a database that already has it, on one with data, and when re-run. Plain
CREATE INDEX (it runs in the migration transaction, so no CONCURRENTLY): a few milliseconds on the small live tables, and it briefly
blocks writes to `orders`. No data changes. Fully reversible (the downgrade drops the index).

Revision ID: e9b1d3f5a7c2
Revises: d6f8b0c2e4a7
Create Date: 2026-11-03 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'e9b1d3f5a7c2'
down_revision: Union[str, Sequence[str], None] = 'd6f8b0c2e4a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_orders_open_by_table ON orders (table_id) WHERE status IN ('open', 'sent_to_kitchen')")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_orders_open_by_table")
