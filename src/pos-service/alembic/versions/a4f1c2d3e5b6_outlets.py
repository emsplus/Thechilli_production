"""PR 4 (docs/PHASE1_PLAN.md, docs/OUTLETS.md): outlets table (RLS), one default outlet per restaurant with the location-level
settings copied from it. Nothing reads the table yet except the outlets API.

Downgrade drops the table: safe, nothing else references it until PR 5.

Revision ID: a4f1c2d3e5b6
Revises: d4b2c3e5a7f9
Create Date: 2026-10-29 21:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls


revision: str = 'a4f1c2d3e5b6'
down_revision: Union[str, Sequence[str], None] = 'd4b2c3e5a7f9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COPIED = ("address, phone, trn, currency, timezone, country, prices_include_tax, vat_registered, service_charge_percent, "
          "max_cashier_discount_percent, z_report_next_number, auto_reorder_emails, reorder_email_window_hours")


def upgrade() -> None:
    op.create_table(
        'outlets',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('code', sa.String(length=10), nullable=False),
        sa.Column('invoice_prefix', sa.String(length=10), server_default='', nullable=False),
        sa.Column('is_default', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('address', sa.String(length=500), nullable=True),
        sa.Column('phone', sa.String(length=30), nullable=True),
        sa.Column('trn', sa.String(length=20), nullable=True),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('timezone', sa.String(length=64), nullable=False),
        sa.Column('country', sa.String(length=2), server_default='AE', nullable=False),
        sa.Column('prices_include_tax', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('vat_registered', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('service_charge_percent', sa.Numeric(5, 2), server_default='0', nullable=False),
        sa.Column('max_cashier_discount_percent', sa.Numeric(5, 2), server_default='10', nullable=False),
        sa.Column('z_report_next_number', sa.Integer(), server_default='1', nullable=False),
        sa.Column('auto_reorder_emails', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('reorder_email_window_hours', sa.Integer(), server_default='12', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'code'),
        sa.UniqueConstraint('id', 'restaurant_id'),
        sa.CheckConstraint("is_default OR invoice_prefix <> ''", name='ck_outlets_prefix'),
    )
    op.create_index(op.f('ix_outlets_restaurant_id'), 'outlets', ['restaurant_id'], unique=False)
    op.create_index('one_default_outlet', 'outlets', ['restaurant_id'], unique=True, postgresql_where=sa.text('is_default'))
    op.create_index('uq_outlets_prefix', 'outlets', ['restaurant_id', 'invoice_prefix'], unique=True,
                    postgresql_where=sa.text("invoice_prefix <> ''"))
    # One default outlet per existing restaurant. Random id (NOT the restaurant's id: that would hide every place where a
    # restaurant id is passed as an outlet id). Idempotent: restaurants that already have one are skipped.
    op.execute(f"""
        INSERT INTO outlets (id, restaurant_id, name, code, invoice_prefix, is_default, {COPIED})
        SELECT gen_random_uuid(), r.id, r.name, 'MAIN', '', true, {', '.join('r.' + c.strip() for c in COPIED.split(','))}
        FROM restaurants r
        WHERE NOT EXISTS (SELECT 1 FROM outlets o WHERE o.restaurant_id = r.id AND o.is_default)""")
    bind = op.get_bind()
    n_r = bind.scalar(sa.text("SELECT count(*) FROM restaurants"))
    n_o = bind.scalar(sa.text("SELECT count(*) FROM outlets WHERE is_default"))
    print(f"outlets backfill: restaurants={n_r} default_outlets={n_o}")
    if n_r != n_o:
        raise RuntimeError("outlets backfill incomplete")
    rls.enable_tables(bind, ("outlets",))


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), ("outlets",))
    op.drop_table('outlets')
