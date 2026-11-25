"""cashier shifts / cash reconciliation: cash_sessions (RLS), permission cashier.shift

Revision ID: c5a1e7b3d9f2
Revises: c3e9b5a1d7f4
Create Date: 2026-10-31 09:20:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import permissions, rls

revision: str = 'c5a1e7b3d9f2'
down_revision: Union[str, Sequence[str], None] = 'c3e9b5a1d7f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MONEY = sa.Numeric(12, 2)


def upgrade() -> None:
    op.create_table(
        'cash_sessions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('outlet_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('cashier_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('status', sa.String(10), server_default='open', nullable=False),
        sa.Column('opened_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('opening_float', MONEY, server_default='0', nullable=False),
        sa.Column('closed_at', sa.DateTime(timezone=True)),
        sa.Column('closed_by', postgresql.UUID(as_uuid=True)),
        sa.Column('counted_cash', MONEY),
        sa.Column('expected_cash', MONEY),
        sa.Column('variance', MONEY),
        sa.Column('variance_reason', sa.String(300)),
        sa.Column('breakdown', sa.JSON()),
        sa.Column('idempotency_key', postgresql.UUID(as_uuid=True)),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['cashier_id'], ['users.id']),
        sa.ForeignKeyConstraint(['closed_by'], ['users.id']),
        sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name='fk_cash_sessions_outlet'),
    )
    op.create_index('ix_cash_sessions_restaurant_id', 'cash_sessions', ['restaurant_id'])
    op.create_index('ix_cash_sessions_outlet_id', 'cash_sessions', ['outlet_id'])
    op.create_index('ix_cash_sessions_restaurant_opened', 'cash_sessions', ['restaurant_id', 'opened_at'])
    op.create_index('uq_cash_sessions_one_open', 'cash_sessions', ['outlet_id', 'cashier_id'], unique=True,
                    postgresql_where=sa.text("status = 'open'"))
    rls.enable_tables(op.get_bind(), ("cash_sessions",))
    permissions.seed_system_roles(op.get_bind())


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), ("cash_sessions",))
    op.drop_table('cash_sessions')
