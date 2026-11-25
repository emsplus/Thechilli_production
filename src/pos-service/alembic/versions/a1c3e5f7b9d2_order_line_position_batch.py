"""order lines: stable position + batch_uuid (add items to an order that was already placed)

Revision ID: a1c3e5f7b9d2
Revises: f9d2b4c6e8a1
Create Date: 2026-10-29 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1c3e5f7b9d2'
down_revision: Union[str, Sequence[str], None] = 'f9d2b4c6e8a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("order_lines", sa.Column("position", sa.Integer(), server_default="0", nullable=False))
    op.add_column("order_lines", sa.Column("batch_uuid", sa.Uuid(), nullable=True))
    op.create_index("ix_order_lines_batch_uuid", "order_lines", ["batch_uuid"])
    # Existing lines have no defined order; physical order is the best available (it is what the relationship returned).
    op.execute("""
        UPDATE order_lines SET position = n.rn FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY ctid) - 1 AS rn FROM order_lines
        ) n WHERE order_lines.id = n.id
    """)


def downgrade() -> None:
    op.drop_index("ix_order_lines_batch_uuid", table_name="order_lines")
    op.drop_column("order_lines", "batch_uuid")
    op.drop_column("order_lines", "position")
