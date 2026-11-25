"""Kitchen lateness target and the GRN <-> purchase invoice link.

* restaurants.kitchen_target_minutes: INTEGER NOT NULL DEFAULT 15, CHECK 5..120. Existing rows get 15 (the value the UIs
  used as a fixed constant before).
* goods_receipts.purchase_invoice_id: nullable FK -> purchase_invoices.id (indexed). Links a goods receipt (delivery
  against a purchase order) to the supplier's bill scanned under Purchases, so the double-post guard recognises the bill
  even when the GRN was saved without the supplier's bill number (docs/INVENTORY.md "Supplier bills and GRNs").

Nothing existing changes meaning. Downgrade drops both columns.

Revision ID: a7c2e9d4b1f3
Revises: b4e7a2c9d6f3
Create Date: 2026-10-31 23:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a7c2e9d4b1f3'
down_revision: Union[str, Sequence[str], None] = 'b4e7a2c9d6f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('restaurants', sa.Column('kitchen_target_minutes', sa.Integer(), server_default='15', nullable=False))
    op.create_check_constraint('ck_restaurants_kitchen_target_minutes', 'restaurants',
                               'kitchen_target_minutes BETWEEN 5 AND 120')
    # goods_receipts is created from the CURRENT model by revision 7a2e9c4b1d60 (Table.create), so on a fresh database the
    # column, its FK and its index already exist at this point: add them only where missing (same names as the model's).
    op.execute("ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS purchase_invoice_id UUID")
    op.execute("""DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'goods_receipts'::regclass AND contype = 'f'
                       AND conname = 'goods_receipts_purchase_invoice_id_fkey') THEN
            ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_purchase_invoice_id_fkey
                FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices (id);
        END IF; END $$""")
    op.execute("CREATE INDEX IF NOT EXISTS ix_goods_receipts_purchase_invoice_id ON goods_receipts (purchase_invoice_id)")

def downgrade() -> None:
    op.drop_index(op.f('ix_goods_receipts_purchase_invoice_id'), table_name='goods_receipts')
    op.drop_constraint('goods_receipts_purchase_invoice_id_fkey', 'goods_receipts', type_='foreignkey')
    op.drop_column('goods_receipts', 'purchase_invoice_id')
    op.drop_constraint('ck_restaurants_kitchen_target_minutes', 'restaurants', type_='check')
    op.drop_column('restaurants', 'kitchen_target_minutes')
