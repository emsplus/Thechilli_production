"""delivery: settings, delivery orders, webhook outbox (RLS) and the outbox tenant lookup

Revision ID: d4a6c8e0f2b1
Revises: c1d2e3f4a5b6
Create Date: 2026-10-30 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import definer, rls


revision: str = 'd4a6c8e0f2b1'
down_revision: Union[str, Sequence[str], None] = 'c1d2e3f4a5b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        'delivery_settings',
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('enabled', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('accept_before_kot', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('delivery_fee', sa.Numeric(12, 2), server_default='0', nullable=False),
        sa.Column('free_delivery_above', sa.Numeric(12, 2), nullable=True),
        sa.Column('min_order', sa.Numeric(12, 2), server_default='0', nullable=False),
        sa.Column('radius_km', sa.Numeric(6, 2), nullable=True),
        sa.Column('hours', sa.JSON(), nullable=True),
        sa.Column('webhook_url', sa.String(500), nullable=True),
        sa.Column('webhook_secret', sa.String(100), nullable=True),
        sa.Column('updated_at', TS, server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('restaurant_id'),
    )
    op.create_table(
        'delivery_orders',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('order_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('idempotency_key', sa.String(128), nullable=False),
        sa.Column('request_hash', sa.String(64), nullable=False),
        sa.Column('order_code', sa.String(20), nullable=False),
        sa.Column('delivery_status', sa.String(20), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('channel', sa.String(20), nullable=False),
        sa.Column('customer_name', sa.String(200), nullable=False),
        sa.Column('customer_phone', sa.String(30), nullable=True),
        sa.Column('address_text', sa.String(500), nullable=False),
        sa.Column('lat', sa.Numeric(9, 6), nullable=True),
        sa.Column('lng', sa.Numeric(9, 6), nullable=True),
        sa.Column('subtotal', sa.Numeric(12, 2), nullable=False),
        sa.Column('delivery_fee', sa.Numeric(12, 2), nullable=False),
        sa.Column('tax', sa.Numeric(12, 2), nullable=False),
        sa.Column('total', sa.Numeric(12, 2), nullable=False),
        sa.Column('payment_mode', sa.String(10), nullable=False),
        sa.Column('claimed_paid', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('payment_ref', sa.String(100), nullable=True),
        sa.Column('payment_confirmed', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('created_at', TS, server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', TS, server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['order_id'], ['orders.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'idempotency_key'),
        sa.UniqueConstraint('order_id'),
    )
    op.create_index(op.f('ix_delivery_orders_restaurant_id'), 'delivery_orders', ['restaurant_id'])
    op.create_index(op.f('ix_delivery_orders_order_id'), 'delivery_orders', ['order_id'])
    op.create_index(op.f('ix_delivery_orders_outlet_id'), 'delivery_orders', ['outlet_id'])
    op.create_table(
        'delivery_outbox',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('order_id', UUID, nullable=False),
        sa.Column('event_id', sa.String(64), nullable=False),
        sa.Column('event_type', sa.String(40), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('payload', sa.JSON(), nullable=False),
        sa.Column('status', sa.String(10), server_default='pending', nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('next_attempt_at', TS, server_default=sa.text('now()'), nullable=False),
        sa.Column('last_error', sa.String(300), nullable=True),
        sa.Column('created_at', TS, server_default=sa.text('now()'), nullable=False),
        sa.Column('sent_at', TS, nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['order_id'], ['orders.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id'),
    )
    op.create_index(op.f('ix_delivery_outbox_restaurant_id'), 'delivery_outbox', ['restaurant_id'])
    op.create_index(op.f('ix_delivery_outbox_order_id'), 'delivery_outbox', ['order_id'])
    op.create_index('ix_delivery_outbox_due', 'delivery_outbox', ['next_attempt_at'],
                    postgresql_where=sa.text("status = 'pending'"))
    conn = op.get_bind()
    rls.enable_tables(conn, rls.DELIVERY_TABLES)
    args, sql = definer.FUNCTIONS["delivery_outbox_tenants"]
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION delivery_outbox_tenants({args}) FROM PUBLIC")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS delivery_outbox_tenants(timestamp with time zone)")
    rls.disable_tables(op.get_bind(), rls.DELIVERY_TABLES)
    op.drop_table('delivery_outbox')
    op.drop_table('delivery_orders')
    op.drop_table('delivery_settings')
