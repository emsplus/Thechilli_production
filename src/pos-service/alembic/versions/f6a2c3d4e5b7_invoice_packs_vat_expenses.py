"""Invoice pack derivation, VAT totals, consumable lines and the expenses table

purchase_invoices: net, vat, supplier_name_raw, supplier_vat_number, document_type (default 'stock_purchase').
purchase_lines: pack (JSON), needs_check, check_reason, exclude_from_stock, item_code, vat_code, vat_rate.
expenses: bills that are not stock (utilities, telecom ...), unique per (restaurant, lower(supplier), invoice number).
Every new column is nullable or defaulted, so existing rows and clients are unaffected. The stock ledger is untouched.

Revision ID: f6a2c3d4e5b7
Revises: e5f1b2c3d4a6
Create Date: 2026-10-25 19:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6a2c3d4e5b7'
down_revision: Union[str, Sequence[str], None] = 'e5f1b2c3d4a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('purchase_invoices', sa.Column('net', sa.Numeric(12, 2), nullable=True))
    op.add_column('purchase_invoices', sa.Column('vat', sa.Numeric(12, 2), nullable=True))
    op.add_column('purchase_invoices', sa.Column('supplier_name_raw', sa.String(200), nullable=True))
    op.add_column('purchase_invoices', sa.Column('supplier_vat_number', sa.String(30), nullable=True))
    op.add_column('purchase_invoices', sa.Column('document_type', sa.String(20), server_default='stock_purchase', nullable=False))
    op.add_column('purchase_lines', sa.Column('pack', sa.JSON(), nullable=True))
    op.add_column('purchase_lines', sa.Column('needs_check', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('purchase_lines', sa.Column('check_reason', sa.String(300), nullable=True))
    op.add_column('purchase_lines', sa.Column('exclude_from_stock', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('purchase_lines', sa.Column('item_code', sa.String(50), nullable=True))
    op.add_column('purchase_lines', sa.Column('vat_code', sa.String(10), nullable=True))
    op.add_column('purchase_lines', sa.Column('vat_rate', sa.Numeric(5, 2), nullable=True))
    op.create_table('expenses',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('restaurant_id', sa.UUID(), nullable=False),
        sa.Column('supplier_id', sa.UUID(), nullable=True),
        sa.Column('supplier_name', sa.String(200), nullable=False),
        sa.Column('invoice_number', sa.String(100), nullable=True),
        sa.Column('expense_date', sa.Date(), nullable=False),
        sa.Column('category', sa.String(30), nullable=False),
        sa.Column('net', sa.Numeric(12, 2), nullable=False),
        sa.Column('vat', sa.Numeric(12, 2), nullable=False),
        sa.Column('gross', sa.Numeric(12, 2), nullable=False),
        sa.Column('note', sa.String(300), nullable=True),
        sa.Column('invoice_id', sa.UUID(), nullable=True),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.ForeignKeyConstraint(['invoice_id'], ['purchase_invoices.id']),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_expenses_restaurant_id'), 'expenses', ['restaurant_id'])
    op.create_index(op.f('ix_expenses_supplier_id'), 'expenses', ['supplier_id'])
    op.create_index(op.f('ix_expenses_invoice_id'), 'expenses', ['invoice_id'])
    op.create_index(op.f('ix_expenses_created_by'), 'expenses', ['created_by'])
    op.create_index(op.f('ix_expenses_expense_date'), 'expenses', ['expense_date'])
    op.create_index('uq_expense_invoice', 'expenses', ['restaurant_id', sa.text('lower(supplier_name)'), 'invoice_number'],
                    unique=True, postgresql_where=sa.text('invoice_number IS NOT NULL'))


def downgrade() -> None:
    op.drop_index('uq_expense_invoice', table_name='expenses')
    op.drop_table('expenses')
    for c in ('vat_rate', 'vat_code', 'item_code', 'exclude_from_stock', 'check_reason', 'needs_check', 'pack'):
        op.drop_column('purchase_lines', c)
    for c in ('document_type', 'supplier_vat_number', 'supplier_name_raw', 'vat', 'net'):
        op.drop_column('purchase_invoices', c)
