"""Customers: name and phone each optional (at least one required)

Staff may add a customer at the till with only a name, only a phone, or both. Both columns become nullable and a
CHECK keeps at least one of them. UNIQUE(restaurant_id, phone) stays: Postgres treats NULLs as distinct, so many
phone-less customers are allowed while a phone is still unique per restaurant. No existing row is rewritten.

Downgrade restores NOT NULL: a phone-less customer cannot be represented in the old schema, so the downgrade stops
with a clear error if any exist (nothing is silently invented or deleted); nameless customers get their phone as name.

Revision ID: b8c4d2e6f1a9
Revises: a7b3c4d5e6f8
Create Date: 2026-10-25 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b8c4d2e6f1a9'
down_revision: Union[str, Sequence[str], None] = 'a7b3c4d5e6f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column('customers', 'name', existing_type=sa.String(length=200), nullable=True)
    op.alter_column('customers', 'phone', existing_type=sa.String(length=20), nullable=True)
    op.create_check_constraint('ck_customers_name_or_phone', 'customers', 'name IS NOT NULL OR phone IS NOT NULL')


def downgrade() -> None:
    n = op.get_bind().execute(sa.text("SELECT count(*) FROM customers WHERE phone IS NULL")).scalar()
    if n:
        raise RuntimeError(f"Cannot downgrade: {n} customer(s) have no phone number. Add their phone numbers first.")
    op.execute("UPDATE customers SET name = phone WHERE name IS NULL")
    op.drop_constraint('ck_customers_name_or_phone', 'customers', type_='check')
    op.alter_column('customers', 'phone', existing_type=sa.String(length=20), nullable=False)
    op.alter_column('customers', 'name', existing_type=sa.String(length=200), nullable=False)
