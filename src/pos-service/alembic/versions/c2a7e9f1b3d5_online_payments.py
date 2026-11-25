"""payments-service integration (docs/PAYMENTS_INTEGRATION.md): payment_provider_accounts (secret REFERENCES only) and
online_payments (one row per attempt to collect a bill online), both tenant tables with RLS.

Downgrade drops both tables (the bill's own `payments` rows created from online payments stay; they are ordinary payments).

Revision ID: c2a7e9f1b3d5
Revises: b9e1c3d5f7a2
Create Date: 2026-10-30 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls

revision: str = 'c2a7e9f1b3d5'
down_revision: Union[str, Sequence[str], None] = 'b9e1c3d5f7a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("payment_provider_accounts", "online_payments")
UUID = postgresql.UUID(as_uuid=True)
MONEY = sa.Numeric(12, 2)


def upgrade() -> None:
    op.create_table(
        'payment_provider_accounts',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('provider', sa.String(20), nullable=False),
        sa.Column('remote_account_id', UUID, nullable=False),
        sa.Column('key_id_ref', sa.String(80), nullable=False),
        sa.Column('key_secret_ref', sa.String(80), nullable=False),
        sa.Column('webhook_secret_ref', sa.String(80), nullable=False),
        sa.Column('active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('created_by', UUID, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_payment_provider_accounts_restaurant_id'), 'payment_provider_accounts', ['restaurant_id'])
    op.create_index(op.f('ix_payment_provider_accounts_created_by'), 'payment_provider_accounts', ['created_by'])
    op.create_index('uq_payment_provider_accounts_active', 'payment_provider_accounts', ['restaurant_id', 'provider'],
                    unique=True, postgresql_where=sa.text('active'))
    op.create_table(
        'online_payments',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('bill_id', UUID, nullable=False),
        sa.Column('idempotency_key', UUID, nullable=False),
        sa.Column('method', sa.String(20), nullable=False),
        sa.Column('amount', MONEY, nullable=False),
        sa.Column('currency', sa.String(3), nullable=False),
        sa.Column('description', sa.String(200), server_default='', nullable=False),
        sa.Column('provider_account_id', UUID, nullable=False),
        sa.Column('status', sa.String(20), server_default='creating', nullable=False),
        sa.Column('remote_intent_id', UUID, nullable=True),
        sa.Column('payment_url', sa.String(1000), nullable=True),
        sa.Column('qr_payload', sa.String(2000), nullable=True),
        sa.Column('captured_amount', MONEY, server_default='0', nullable=False),
        sa.Column('applied_amount', MONEY, server_default='0', nullable=False),
        sa.Column('unallocated_amount', MONEY, server_default='0', nullable=False),
        sa.Column('last_error', sa.String(300), nullable=True),
        sa.Column('last_synced_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', UUID, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['bill_id'], ['bills.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name='fk_online_payments_outlet'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'idempotency_key'),
    )
    for col in ('restaurant_id', 'outlet_id', 'bill_id', 'created_by'):
        op.create_index(op.f(f'ix_online_payments_{col}'), 'online_payments', [col])
    rls.enable_tables(op.get_bind(), TABLES)


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), TABLES)
    op.drop_table('online_payments')
    op.drop_table('payment_provider_accounts')
