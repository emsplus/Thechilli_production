"""country-aware tax: UK VAT engine columns

Revision ID: d4e8a1b7c9f2
Revises: c7a1f4e9d2b3
Create Date: 2026-10-26 09:00:00

All new columns have defaults that reproduce the existing Dubai behaviour (country AE, tax-exclusive prices,
standard rate, no discount/service charge), so existing rows and clients keep working unchanged.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4e8a1b7c9f2'
down_revision: Union[str, Sequence[str], None] = 'c7a1f4e9d2b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # restaurants
    op.add_column('restaurants', sa.Column('country', sa.String(length=2), server_default='AE', nullable=False))
    op.add_column('restaurants', sa.Column('prices_include_tax', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('restaurants', sa.Column('vat_registered', sa.Boolean(), server_default='true', nullable=False))
    op.add_column('restaurants', sa.Column('service_charge_percent', sa.Numeric(5, 2), server_default='0', nullable=False))
    op.add_column('restaurants', sa.Column('max_cashier_discount_percent', sa.Numeric(5, 2), server_default='10', nullable=False))
    # tax_rates
    op.add_column('tax_rates', sa.Column('code', sa.String(length=20), server_default='standard', nullable=False))
    op.create_unique_constraint('uq_tax_rates_restaurant_code_from', 'tax_rates',
                                ['restaurant_id', 'code', 'effective_from'])
    # menu_items
    op.add_column('menu_items', sa.Column('tax_kind', sa.String(length=12), server_default='standard', nullable=False))
    # bills
    op.add_column('bills', sa.Column('country', sa.String(length=2), server_default='AE', nullable=False))
    op.add_column('bills', sa.Column('prices_include_tax', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('bills', sa.Column('vat_registered', sa.Boolean(), server_default='true', nullable=False))
    op.add_column('bills', sa.Column('discount_amount', sa.Numeric(12, 2), server_default='0', nullable=False))
    op.add_column('bills', sa.Column('discount_reason', sa.String(length=200), nullable=True))
    op.add_column('bills', sa.Column('service_charge_amount', sa.Numeric(12, 2), server_default='0', nullable=False))
    op.add_column('bills', sa.Column('service_charge_percent', sa.Numeric(5, 2), server_default='0', nullable=False))
    op.add_column('bills', sa.Column('tax_breakdown', sa.JSON(), nullable=True))  # null on old bills
    # bill_lines (all nullable: old rows are tax-exclusive, net = line_total)
    op.add_column('bill_lines', sa.Column('item_id', sa.UUID(), nullable=True))
    op.create_foreign_key('fk_bill_lines_item_id_menu_items', 'bill_lines', 'menu_items', ['item_id'], ['id'])
    op.create_index(op.f('ix_bill_lines_item_id'), 'bill_lines', ['item_id'], unique=False)
    op.add_column('bill_lines', sa.Column('tax_code', sa.String(length=20), nullable=True))
    op.add_column('bill_lines', sa.Column('tax_rate_percent', sa.Numeric(5, 2), nullable=True))
    op.add_column('bill_lines', sa.Column('net_amount', sa.Numeric(12, 2), nullable=True))
    op.add_column('bill_lines', sa.Column('vat_amount', sa.Numeric(12, 2), nullable=True))
    op.add_column('bill_lines', sa.Column('gross_amount', sa.Numeric(12, 2), nullable=True))


def downgrade() -> None:
    for c in ('gross_amount', 'vat_amount', 'net_amount', 'tax_rate_percent', 'tax_code'):
        op.drop_column('bill_lines', c)
    op.drop_index(op.f('ix_bill_lines_item_id'), table_name='bill_lines')
    op.drop_constraint('fk_bill_lines_item_id_menu_items', 'bill_lines', type_='foreignkey')
    op.drop_column('bill_lines', 'item_id')
    for c in ('tax_breakdown', 'service_charge_percent', 'service_charge_amount', 'discount_reason',
              'discount_amount', 'vat_registered', 'prices_include_tax', 'country'):
        op.drop_column('bills', c)
    op.drop_column('menu_items', 'tax_kind')
    op.drop_constraint('uq_tax_rates_restaurant_code_from', 'tax_rates', type_='unique')
    op.execute("DELETE FROM tax_rates WHERE code <> 'standard'")  # without `code` a zero row would look like a 2nd standard
    op.drop_column('tax_rates', 'code')
    for c in ('max_cashier_discount_percent', 'service_charge_percent', 'vat_registered', 'prices_include_tax',
              'country'):
        op.drop_column('restaurants', c)
