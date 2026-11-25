"""whole-bill void: bills.voided_at / voided_by / void_reason, permission bills.void (system role rows re-seeded)

Revision ID: c1d7a3e9f5b2
Revises: d4a6c8e0f2b1
Create Date: 2026-10-31 09:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import permissions

revision: str = 'c1d7a3e9f5b2'
down_revision: Union[str, Sequence[str], None] = 'd4a6c8e0f2b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('bills', sa.Column('voided_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('bills', sa.Column('voided_by', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('bills', sa.Column('void_reason', sa.String(300), nullable=True))
    op.create_foreign_key('fk_bills_voided_by', 'bills', 'users', ['voided_by'], ['id'])
    permissions.seed_system_roles(op.get_bind())


def downgrade() -> None:
    op.drop_constraint('fk_bills_voided_by', 'bills', type_='foreignkey')
    op.drop_column('bills', 'void_reason')
    op.drop_column('bills', 'voided_by')
    op.drop_column('bills', 'voided_at')
