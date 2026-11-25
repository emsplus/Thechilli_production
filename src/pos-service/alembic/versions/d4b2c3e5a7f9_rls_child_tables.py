"""PR 3b (docs/PHASE1_PLAN.md): RLS on the child tables without a tenant column (visible iff the parent row is visible). Needs 3a.

Revision ID: d4b2c3e5a7f9
Revises: c3a1b2d4e6f8
Create Date: 2026-10-29 19:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

from app.core import rls


revision: str = 'd4b2c3e5a7f9'
down_revision: Union[str, Sequence[str], None] = 'c3a1b2d4e6f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    rls.enable_children(op.get_bind())


def downgrade() -> None:
    rls.disable_children(op.get_bind())
