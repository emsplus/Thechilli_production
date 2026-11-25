"""PR 3a (docs/PHASE1_PLAN.md): app_tenant() and ENABLE ROW LEVEL SECURITY + tenant_isolation policy on the root and every table with a restaurant_id. ENABLE, not FORCE: the owner role is exempt. Kill switch: docs/RLS.md.

Revision ID: c3a1b2d4e6f8
Revises: b2d4f6a8c0e1
Create Date: 2026-10-29 19:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

from app.core import rls


revision: str = 'c3a1b2d4e6f8'
down_revision: Union[str, Sequence[str], None] = 'b2d4f6a8c0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    rls.enable_direct(op.get_bind(), rls.DIRECT_TABLES_3A)


def downgrade() -> None:
    rls.disable_direct(op.get_bind(), rls.DIRECT_TABLES_3A)
