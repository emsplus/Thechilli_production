"""Chilli recharge: Razorpay payment-link fields on wallet_topup_orders, razorpay_events (webhook dedupe + audit trail).
The wallet / ledger / usage tables already exist (0005); this only adds what the Razorpay payment link flow needs.

Revision ID: 0007
Revises: 0006
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.add_column('wallet_topup_orders', sa.Column('provider_link_id', sa.String(100), nullable=True))
    op.add_column('wallet_topup_orders', sa.Column('short_url', sa.String(300), nullable=True))
    op.add_column('wallet_topup_orders', sa.Column('expires_at', TS, nullable=True))
    op.create_unique_constraint('uq_wallet_topup_orders_link', 'wallet_topup_orders', ['provider_link_id'])
    op.create_index('ix_wallet_topup_orders_tenant_created', 'wallet_topup_orders', ['tenant_id', 'created_at'])
    op.create_table(
        'razorpay_events',
        sa.Column('id', sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column('event_id', sa.String(120), nullable=False, unique=True),
        sa.Column('event', sa.String(40), nullable=False),
        sa.Column('payment_id', sa.String(100)),
        sa.Column('topup_order_id', UUID),
        sa.Column('tenant_id', UUID),
        sa.Column('amount_paise', sa.BigInteger()),
        sa.Column('outcome', sa.String(32), nullable=False),
        sa.Column('received_at', TS),
    )
    op.create_index('ix_razorpay_events_payment_id', 'razorpay_events', ['payment_id'])


def downgrade() -> None:
    op.drop_table('razorpay_events')
    op.drop_index('ix_wallet_topup_orders_tenant_created', table_name='wallet_topup_orders')
    op.drop_constraint('uq_wallet_topup_orders_link', 'wallet_topup_orders', type_='unique')
    op.drop_column('wallet_topup_orders', 'expires_at')
    op.drop_column('wallet_topup_orders', 'short_url')
    op.drop_column('wallet_topup_orders', 'provider_link_id')
