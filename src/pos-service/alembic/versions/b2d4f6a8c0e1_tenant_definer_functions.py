"""tenant plumbing: SECURITY DEFINER lookups for pre-tenant / cross-tenant paths (docs/PHASE1_PLAN.md PR 2)

No table or data change. The functions are created as the migration role (MIGRATION_ROLE, the owner role after the role
split) and are not executable by PUBLIC; see app/core/definer.py.

Revision ID: b2d4f6a8c0e1
Revises: a1c3e5f7b9d2
Create Date: 2026-10-29 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

from app.core import definer


revision: str = 'b2d4f6a8c0e1'
down_revision: Union[str, Sequence[str], None] = 'a1c3e5f7b9d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    definer.create_all(op.get_bind(), as_of_pr2=True)


def downgrade() -> None:
    definer.drop_all(op.get_bind())
