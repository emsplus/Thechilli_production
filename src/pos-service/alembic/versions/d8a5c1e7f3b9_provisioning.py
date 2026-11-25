"""provisioning: provisioning_requests (global idempotency ledger) and user_invites (tenant table, RLS)

Revision ID: d8a5c1e7f3b9
Revises: c8a4e1f2b3d7
Create Date: 2026-10-30 15:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls

revision: str = 'd8a5c1e7f3b9'
down_revision: Union[str, Sequence[str], None] = 'c8a4e1f2b3d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        'provisioning_requests',
        sa.Column('id', UUID, nullable=False),
        sa.Column('key_hash', sa.String(64), nullable=False),
        sa.Column('request_hash', sa.String(64), nullable=False),
        sa.Column('tenant_id', UUID, nullable=False),
        sa.Column('plan_code', sa.String(64), nullable=True),
        sa.Column('hints', postgresql.JSONB(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key_hash'),
        sa.UniqueConstraint('tenant_id'),
    )
    op.create_table(
        'user_invites',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('token_hash', sa.String(64), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('voided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_user_invites_restaurant_id', 'user_invites', ['restaurant_id'])
    op.create_index('ix_user_invites_user_id', 'user_invites', ['user_id'])
    rls.enable_tables(op.get_bind(), ("user_invites",))


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), ("user_invites",))
    op.drop_index('ix_user_invites_user_id', table_name='user_invites')
    op.drop_index('ix_user_invites_restaurant_id', table_name='user_invites')
    op.drop_table('user_invites')
    op.drop_table('provisioning_requests')
