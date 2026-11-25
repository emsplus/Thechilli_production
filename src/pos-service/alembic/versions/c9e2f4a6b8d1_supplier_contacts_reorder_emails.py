"""supplier contacts, usual supplier on stock items, re-order emails

Supplier gets email / contact_name / auto_reorder; inventory items get a "usual supplier" (supplier_id, supplier_manual) and
an optional reorder_quantity (base unit); restaurants get the two re-order switches; alerts remember whether their
supplier email is still pending / which email covered them; new table supplier_emails is the log of every re-order email.

All new columns are nullable or have defaults, so existing rows and clients are unaffected. Fully reversible (the downgrade
drops the new columns and table; the email log is lost, nothing else).

Revision ID: c9e2f4a6b8d1
Revises: b8c4d2e6f1a9
Create Date: 2026-10-26 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'c9e2f4a6b8d1'
down_revision: Union[str, Sequence[str], None] = 'b8c4d2e6f1a9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('suppliers', sa.Column('email', sa.String(length=254), nullable=True))
    op.add_column('suppliers', sa.Column('contact_name', sa.String(length=120), nullable=True))
    op.add_column('suppliers', sa.Column('auto_reorder', sa.Boolean(), server_default='true', nullable=False))

    op.add_column('restaurants', sa.Column('auto_reorder_emails', sa.Boolean(), server_default='true', nullable=False))
    op.add_column('restaurants', sa.Column('reorder_email_window_hours', sa.Integer(), server_default='12', nullable=False))

    op.create_table(
        'supplier_emails',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('supplier_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('to_email', sa.String(length=254), nullable=False),
        sa.Column('subject', sa.String(length=300), nullable=False),
        sa.Column('body_text', sa.Text(), nullable=False),
        sa.Column('body_html', sa.Text(), nullable=True),
        sa.Column('items', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('note', sa.String(length=500), nullable=True),
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('status', sa.String(length=10), nullable=False),
        sa.Column('error', sa.String(length=500), nullable=True),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('dedupe_key', sa.String(length=100), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('dedupe_key'),
    )
    op.create_index('ix_supplier_emails_restaurant_id', 'supplier_emails', ['restaurant_id'])
    op.create_index('ix_supplier_emails_supplier_id', 'supplier_emails', ['supplier_id'])
    op.create_index('ix_supplier_emails_created_by', 'supplier_emails', ['created_by'])

    op.add_column('inventory_items', sa.Column('supplier_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('inventory_items', sa.Column('supplier_manual', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('inventory_items', sa.Column('reorder_quantity', sa.Numeric(12, 3), nullable=True))
    op.create_foreign_key('fk_inventory_items_supplier_id', 'inventory_items', 'suppliers', ['supplier_id'], ['id'])
    op.create_index('ix_inventory_items_supplier_id', 'inventory_items', ['supplier_id'])

    op.add_column('alerts', sa.Column('email_pending', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('alerts', sa.Column('supplier_email_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key('fk_alerts_supplier_email_id', 'alerts', 'supplier_emails', ['supplier_email_id'], ['id'])
    op.create_index('ix_alerts_supplier_email_id', 'alerts', ['supplier_email_id'])


def downgrade() -> None:
    op.drop_index('ix_alerts_supplier_email_id', table_name='alerts')
    op.drop_constraint('fk_alerts_supplier_email_id', 'alerts', type_='foreignkey')
    op.drop_column('alerts', 'supplier_email_id')
    op.drop_column('alerts', 'email_pending')

    op.drop_index('ix_inventory_items_supplier_id', table_name='inventory_items')
    op.drop_constraint('fk_inventory_items_supplier_id', 'inventory_items', type_='foreignkey')
    op.drop_column('inventory_items', 'reorder_quantity')
    op.drop_column('inventory_items', 'supplier_manual')
    op.drop_column('inventory_items', 'supplier_id')

    op.drop_index('ix_supplier_emails_created_by', table_name='supplier_emails')
    op.drop_index('ix_supplier_emails_supplier_id', table_name='supplier_emails')
    op.drop_index('ix_supplier_emails_restaurant_id', table_name='supplier_emails')
    op.drop_table('supplier_emails')

    op.drop_column('restaurants', 'reorder_email_window_hours')
    op.drop_column('restaurants', 'auto_reorder_emails')
    op.drop_column('suppliers', 'auto_reorder')
    op.drop_column('suppliers', 'contact_name')
    op.drop_column('suppliers', 'email')
