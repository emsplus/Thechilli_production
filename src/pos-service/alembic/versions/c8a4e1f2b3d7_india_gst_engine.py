"""India GST engine columns (tax_mode, GST config, HSN, bill GST snapshot, credit-note documents)

restaurants: tax_mode ('off' default), gst_config (JSON).
menu_items: hsn, supply_type (default 'restaurant'), gst_rate_code.
customers: gstin, state_code.
bills: tax_mode, document_type, seller_gstin, customer_gstin, customer_state_code, place_of_supply, cgst/sgst/igst_amount,
       round_off (total = subtotal + tax_amount + round_off), packaging_amount, delivery_amount, gst_document (JSON).
bill_lines: hsn, cgst/sgst/igst_amount.
refunds: round_off, credit_note_doc (JSON, engine CreditNote.to_dict()).
No new tables (so no new RLS policies): every column lives on a table that already has its policy. Existing rows keep
their meaning: tax_mode 'off', zero round-off and GST amounts.

Revision ID: c8a4e1f2b3d7
Revises: c5a1e7b3d9f2
Create Date: 2026-10-30 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'c8a4e1f2b3d7'
down_revision: Union[str, Sequence[str], None] = 'c5a1e7b3d9f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MONEY = sa.Numeric(12, 2)


def _money(table: str, *names: str, nullable: bool = False) -> None:
    for n in names:
        if nullable:
            op.add_column(table, sa.Column(n, MONEY, nullable=True))
        else:
            op.add_column(table, sa.Column(n, MONEY, nullable=False, server_default="0"))


def upgrade() -> None:
    op.add_column("restaurants", sa.Column("tax_mode", sa.String(12), nullable=False, server_default="off"))
    op.add_column("restaurants", sa.Column("gst_config", sa.JSON(none_as_null=True), nullable=True))
    op.add_column("menu_items", sa.Column("hsn", sa.String(8), nullable=True))
    op.add_column("menu_items", sa.Column("supply_type", sa.String(12), nullable=False, server_default="restaurant"))
    op.add_column("menu_items", sa.Column("gst_rate_code", sa.String(20), nullable=True))
    op.add_column("customers", sa.Column("gstin", sa.String(15), nullable=True))
    op.add_column("customers", sa.Column("state_code", sa.String(2), nullable=True))
    op.add_column("bills", sa.Column("tax_mode", sa.String(12), nullable=False, server_default="off"))
    op.add_column("bills", sa.Column("document_type", sa.String(16), nullable=False, server_default="tax_invoice"))
    for n, w in (("seller_gstin", 15), ("customer_gstin", 15), ("customer_state_code", 2), ("place_of_supply", 2)):
        op.add_column("bills", sa.Column(n, sa.String(w), nullable=True))
    _money("bills", "cgst_amount", "sgst_amount", "igst_amount", "round_off", "packaging_amount", "delivery_amount")
    op.add_column("bills", sa.Column("gst_document", sa.JSON(none_as_null=True), nullable=True))
    op.add_column("bill_lines", sa.Column("hsn", sa.String(8), nullable=True))
    _money("bill_lines", "cgst_amount", "sgst_amount", "igst_amount", nullable=True)
    _money("refunds", "round_off")
    op.add_column("refunds", sa.Column("credit_note_doc", sa.JSON(none_as_null=True), nullable=True))


def downgrade() -> None:
    for t, cols in (("refunds", ("credit_note_doc", "round_off")),
                    ("bill_lines", ("igst_amount", "sgst_amount", "cgst_amount", "hsn")),
                    ("bills", ("gst_document", "delivery_amount", "packaging_amount", "round_off", "igst_amount", "sgst_amount",
                               "cgst_amount", "place_of_supply", "customer_state_code", "customer_gstin", "seller_gstin",
                               "document_type", "tax_mode")),
                    ("customers", ("state_code", "gstin")),
                    ("menu_items", ("gst_rate_code", "supply_type", "hsn")),
                    ("restaurants", ("gst_config", "tax_mode"))):
        for c in cols:
            op.drop_column(t, c)
