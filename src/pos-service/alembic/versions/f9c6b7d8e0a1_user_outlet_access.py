"""PR 7 (docs/OUTLETS.md): user_outlet_access (RLS). Owners and managers reach every outlet; other users reach the outlets
granted here, or the default outlet when they have no rows (so every existing user keeps working unchanged).

Downgrade drops the table (grants are lost; users fall back to the default outlet).

Revision ID: f9c6b7d8e0a1
Revises: e8b5a6c7d9f0
Create Date: 2026-10-30 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls


revision: str = 'f9c6b7d8e0a1'
down_revision: Union[str, Sequence[str], None] = 'e8b5a6c7d9f0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'user_outlet_access',
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('outlet_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name='fk_user_outlet_access_outlet'),
        sa.PrimaryKeyConstraint('user_id', 'outlet_id'),
    )
    op.create_index(op.f('ix_user_outlet_access_restaurant_id'), 'user_outlet_access', ['restaurant_id'], unique=False)
    rls.enable_tables(op.get_bind(), ("user_outlet_access",))


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), ("user_outlet_access",))
    op.drop_table('user_outlet_access')
