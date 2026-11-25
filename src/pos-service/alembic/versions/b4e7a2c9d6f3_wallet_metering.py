"""PAYG wallet metering (docs/PAYG_BILLING.md).

* billing_usage_outbox: tenant table with RLS (rls.WALLET_TABLES). One row per (root bill, event) written with the bill, sent to
  platform-core by services/wallet.py.
* billing_usage_tenants(): SECURITY DEFINER lookup of tenants with due rows (the runner has no tenant bound).
* permissions billing.view (owner, manager) and billing.topup (owner): system roles re-seeded.

Nothing existing changes. Bills finalized before this revision are not reported (they were never charged).

Revision ID: b4e7a2c9d6f3
Revises: c4e8a2f6b1d3
Create Date: 2026-10-31 22:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import definer, permissions, rls

revision: str = 'b4e7a2c9d6f3'
down_revision: Union[str, Sequence[str], None] = 'c4e8a2f6b1d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        'billing_usage_outbox',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('bill_id', UUID, nullable=False),
        sa.Column('event', sa.String(10), nullable=False),
        sa.Column('outlet_id', UUID, nullable=True),
        sa.Column('invoice_number', sa.String(40), nullable=True),
        sa.Column('bill_total_paise', sa.BigInteger(), nullable=False),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('offline', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('status', sa.String(10), server_default='pending', nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('next_attempt_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_error', sa.String(300), nullable=True),
        sa.Column('outcome', sa.String(24), nullable=True),
        sa.Column('charged_paise', sa.BigInteger(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("event IN ('finalized', 'voided')", name='ck_billing_usage_event'),
        sa.CheckConstraint("status IN ('pending', 'sent', 'unmanaged')", name='ck_billing_usage_status'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['bill_id'], ['bills.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'bill_id', 'event', name='uq_billing_usage_bill_event'),
    )
    op.create_index(op.f('ix_billing_usage_outbox_restaurant_id'), 'billing_usage_outbox', ['restaurant_id'])
    op.create_index(op.f('ix_billing_usage_outbox_bill_id'), 'billing_usage_outbox', ['bill_id'])
    op.create_index('ix_billing_usage_outbox_due', 'billing_usage_outbox', ['next_attempt_at'],
                    postgresql_where=sa.text("status IN ('pending', 'unmanaged')"))
    conn = op.get_bind()
    rls.enable_tables(conn, rls.WALLET_TABLES)
    args, sql = definer.FUNCTIONS["billing_usage_tenants"]
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION billing_usage_tenants({args}) FROM PUBLIC")
    permissions.seed_system_roles(conn)  # billing.view / billing.topup on the system roles


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS billing_usage_tenants(timestamp with time zone)")
    rls.disable_tables(op.get_bind(), rls.WALLET_TABLES)
    op.drop_table('billing_usage_outbox')
    op.execute("DELETE FROM role_permissions WHERE permission IN ('billing.view', 'billing.topup')")
