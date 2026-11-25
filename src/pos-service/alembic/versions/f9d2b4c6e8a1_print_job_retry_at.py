"""print jobs: retry_at (a failed attempt waits before the next one)

Revision ID: f9d2b4c6e8a1
Revises: e7a9c1b3d5f2
Create Date: 2026-10-29 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f9d2b4c6e8a1'
down_revision: Union[str, Sequence[str], None] = 'e7a9c1b3d5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("print_jobs", sa.Column("retry_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("print_jobs", "retry_at")
