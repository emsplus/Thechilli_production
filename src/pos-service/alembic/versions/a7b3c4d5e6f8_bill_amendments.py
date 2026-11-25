"""Bill amendments (credit note + replacement invoice), sale_at, bill_amend_days, credit_note payment method

bills: sale_at (backfilled = finalized_at, NOT NULL, default now()), status ('active'|'superseded'),
       superseded_by_bill_id, amends_bill_id, amended_at, amended_by, amend_reason.
       UNIQUE(order_id) becomes a partial unique index on the ORIGINAL bill (amends_bill_id IS NULL) so a replacement
       can share the order.
refunds: kind ('refund'|'amendment'), payout_amount, payout_method, replacement_bill_id.
restaurants: bill_amend_days (default 30; 0 = off).
payment_method enum: + 'credit_note'.
Existing rows keep their meaning (all active, kind 'refund'); no existing value is rewritten except the sale_at backfill.

Revision ID: a7b3c4d5e6f8
Revises: f6a2c3d4e5b7
Create Date: 2026-10-26 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7b3c4d5e6f8'
down_revision: Union[str, Sequence[str], None] = 'f6a2c3d4e5b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'credit_note'")
    op.add_column('restaurants', sa.Column('bill_amend_days', sa.Integer(), server_default='30', nullable=False))

    op.add_column('bills', sa.Column('sale_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True))
    op.execute("UPDATE bills SET sale_at = finalized_at")
    op.alter_column('bills', 'sale_at', nullable=False, server_default=sa.text('now()'))
    op.add_column('bills', sa.Column('status', sa.String(12), server_default='active', nullable=False))
    op.add_column('bills', sa.Column('superseded_by_bill_id', sa.UUID(), nullable=True))
    op.add_column('bills', sa.Column('amends_bill_id', sa.UUID(), nullable=True))
    op.add_column('bills', sa.Column('amended_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('bills', sa.Column('amended_by', sa.UUID(), nullable=True))
    op.add_column('bills', sa.Column('amend_reason', sa.String(300), nullable=True))
    for col, ref in (('superseded_by_bill_id', 'bills'), ('amends_bill_id', 'bills'), ('amended_by', 'users')):
        op.create_foreign_key(f'bills_{col}_fkey', 'bills', ref, [col], ['id'])
        op.create_index(f'ix_bills_{col}', 'bills', [col])
    op.create_index('ix_bills_restaurant_sale', 'bills', ['restaurant_id', 'sale_at'])
    op.drop_constraint('bills_order_id_key', 'bills', type_='unique')
    op.create_index('uq_bills_order_original', 'bills', ['order_id'], unique=True,
                    postgresql_where=sa.text('amends_bill_id IS NULL'))

    op.add_column('refunds', sa.Column('kind', sa.String(12), server_default='refund', nullable=False))
    op.add_column('refunds', sa.Column('payout_amount', sa.Numeric(12, 2), server_default='0', nullable=False))
    op.add_column('refunds', sa.Column('payout_method', sa.String(10), nullable=True))
    op.add_column('refunds', sa.Column('replacement_bill_id', sa.UUID(), nullable=True))
    op.create_foreign_key('refunds_replacement_bill_id_fkey', 'refunds', 'bills', ['replacement_bill_id'], ['id'])
    op.create_index('ix_refunds_replacement_bill_id', 'refunds', ['replacement_bill_id'])


def downgrade() -> None:
    # Amendment data cannot be represented in the old schema: refuse rather than silently lose accounting records.
    conn = op.get_bind()
    if conn.scalar(sa.text("SELECT count(*) FROM bills WHERE amends_bill_id IS NOT NULL OR status <> 'active'")):
        raise RuntimeError("Cannot downgrade: the database contains bill amendments (credit note + replacement invoices)")
    op.drop_index('ix_refunds_replacement_bill_id', table_name='refunds')
    op.drop_constraint('refunds_replacement_bill_id_fkey', 'refunds', type_='foreignkey')
    for c in ('replacement_bill_id', 'payout_method', 'payout_amount', 'kind'):
        op.drop_column('refunds', c)
    op.drop_index('uq_bills_order_original', table_name='bills')
    op.create_unique_constraint('bills_order_id_key', 'bills', ['order_id'])
    op.drop_index('ix_bills_restaurant_sale', table_name='bills')
    for col in ('amended_by', 'amends_bill_id', 'superseded_by_bill_id'):
        op.drop_index(f'ix_bills_{col}', table_name='bills')
        op.drop_constraint(f'bills_{col}_fkey', 'bills', type_='foreignkey')
    for c in ('amend_reason', 'amended_by', 'amended_at', 'amends_bill_id', 'superseded_by_bill_id', 'status', 'sale_at'):
        op.drop_column('bills', c)
    op.drop_column('restaurants', 'bill_amend_days')
    # The 'credit_note' enum value stays (PostgreSQL cannot drop enum values); no row can use it after the guard above.
