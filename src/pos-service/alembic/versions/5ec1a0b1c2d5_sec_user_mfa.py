"""security review finding 7: user_mfa (optional TOTP for owners / managers), with RLS

Revision ID: 5ec1a0b1c2d5
Revises: 5ec1a0b1c2d4
Create Date: 2026-10-31 20:20:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls

revision: str = '5ec1a0b1c2d5'
down_revision: Union[str, Sequence[str], None] = '5ec1a0b1c2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("user_mfa",)


def upgrade() -> None:
    op.create_table(
        'user_mfa',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('restaurant_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('secret_enc', sa.String(length=300), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_step', sa.Integer(), nullable=True),
        sa.Column('recovery_hashes', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id'),
    )
    op.create_index(op.f('ix_user_mfa_restaurant_id'), 'user_mfa', ['restaurant_id'])
    rls.enable_tables(op.get_bind(), TABLES)


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), TABLES)
    op.drop_index(op.f('ix_user_mfa_restaurant_id'), table_name='user_mfa')
    op.drop_table('user_mfa')
