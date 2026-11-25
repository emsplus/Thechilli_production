"""Waiter app backend (docs/WAITER_API.md): shifts, table assignments, order token / note / bill request / merge marker.

* shifts (one OPEN shift per user and outlet: partial unique index) and table_assignments: tenant + outlet tables with RLS.
* orders: token_number + token_date (per outlet per day, unique where set), note, bill_requested_at / _by, merged_into_order_id.
  All nullable: old rows and old clients are unaffected.

Downgrade drops the two tables and the new order columns (tokens, notes and bill requests are lost).

Revision ID: d3b8f4a6c1e7
Revises: d8a5c1e7f3b9
Create Date: 2026-10-30 15:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls

revision: str = 'd3b8f4a6c1e7'
down_revision: Union[str, Sequence[str], None] = 'd8a5c1e7f3b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("shifts", "table_assignments")
UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        'shifts',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('role', sa.String(20), nullable=False),
        sa.Column('opened_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('open_note', sa.String(300), nullable=True),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('closed_by', UUID, nullable=True),
        sa.Column('close_reason', sa.String(20), nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['closed_by'], ['users.id']),
        sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name='fk_shifts_outlet'),
        sa.PrimaryKeyConstraint('id'),
    )
    for col in ('restaurant_id', 'outlet_id', 'user_id', 'closed_by'):
        op.create_index(op.f(f'ix_shifts_{col}'), 'shifts', [col])
    op.create_index('uq_shifts_one_open', 'shifts', ['user_id', 'outlet_id'], unique=True,
                    postgresql_where=sa.text('closed_at IS NULL'))
    op.create_table(
        'table_assignments',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('shift_id', UUID, nullable=False),
        sa.Column('table_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('assigned_by', UUID, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['shift_id'], ['shifts.id']),
        sa.ForeignKeyConstraint(['table_id'], ['dining_tables.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['assigned_by'], ['users.id']),
        sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name='fk_table_assignments_outlet'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('shift_id', 'table_id'),
    )
    for col in ('restaurant_id', 'outlet_id', 'shift_id', 'table_id', 'user_id', 'assigned_by'):
        op.create_index(op.f(f'ix_table_assignments_{col}'), 'table_assignments', [col])

    op.add_column('orders', sa.Column('token_number', sa.Integer(), nullable=True))
    op.add_column('orders', sa.Column('token_date', sa.Date(), nullable=True))
    op.add_column('orders', sa.Column('note', sa.String(300), nullable=True))
    op.add_column('orders', sa.Column('bill_requested_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('orders', sa.Column('bill_requested_by', UUID, nullable=True))
    op.add_column('orders', sa.Column('merged_into_order_id', UUID, nullable=True))
    op.create_foreign_key('fk_orders_bill_requested_by', 'orders', 'users', ['bill_requested_by'], ['id'])
    op.create_foreign_key('fk_orders_merged_into', 'orders', 'orders', ['merged_into_order_id'], ['id'])
    op.create_index(op.f('ix_orders_bill_requested_by'), 'orders', ['bill_requested_by'])
    op.create_index(op.f('ix_orders_merged_into_order_id'), 'orders', ['merged_into_order_id'])
    op.create_index('uq_orders_token', 'orders', ['outlet_id', 'token_date', 'token_number'], unique=True,
                    postgresql_where=sa.text('token_number IS NOT NULL'))
    rls.enable_tables(op.get_bind(), TABLES)


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), TABLES)
    op.drop_index('uq_orders_token', table_name='orders')
    op.drop_index(op.f('ix_orders_merged_into_order_id'), table_name='orders')
    op.drop_index(op.f('ix_orders_bill_requested_by'), table_name='orders')
    op.drop_constraint('fk_orders_merged_into', 'orders', type_='foreignkey')
    op.drop_constraint('fk_orders_bill_requested_by', 'orders', type_='foreignkey')
    for c in ('merged_into_order_id', 'bill_requested_by', 'bill_requested_at', 'note', 'token_date', 'token_number'):
        op.drop_column('orders', c)
    op.drop_table('table_assignments')
    op.drop_table('shifts')
