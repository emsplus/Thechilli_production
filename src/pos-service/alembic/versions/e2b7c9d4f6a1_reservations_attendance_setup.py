"""Reservations, staff attendance, setup checklist (docs/RESERVATIONS_ATTENDANCE_SETUP_API.md).

* reservations, attendance_records, attendance_schedules: tenant + outlet tables (composite outlet FK) with RLS.
* setup_step_skips: tenant table with RLS (the only stored part of the setup checklist; completion is derived).
* restaurants.upi_vpa: the restaurant's UPI id (nullable).

Nothing existing changes meaning; all new columns are nullable. Downgrade drops the four tables and the column.

Revision ID: e2b7c9d4f6a1
Revises: d3b8f4a6c1e7
Create Date: 2026-10-31 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls

revision: str = 'e2b7c9d4f6a1'
down_revision: Union[str, Sequence[str], None] = 'e3c5a7b9d1f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("reservations", "attendance_records", "attendance_schedules", "setup_step_skips")
UUID = postgresql.UUID(as_uuid=True)


def _outlet_fk(table: str):
    return sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name=f'fk_{table}_outlet')


def _indexes(table: str, cols) -> None:
    for col in cols:
        op.create_index(op.f(f'ix_{table}_{col}'), table, [col])


def upgrade() -> None:
    op.add_column('restaurants', sa.Column('upi_vpa', sa.String(100), nullable=True))

    op.create_table(
        'reservations',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('client_uuid', UUID, nullable=True),
        sa.Column('guest_name', sa.String(120), nullable=False),
        sa.Column('phone', sa.String(30), nullable=True),
        sa.Column('party_size', sa.Integer(), nullable=False),
        sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('duration_minutes', sa.Integer(), server_default='90', nullable=False),
        sa.Column('table_id', UUID, nullable=True),
        sa.Column('status', sa.String(10), server_default='booked', nullable=False),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('order_id', UUID, nullable=True),
        sa.Column('seated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancel_reason', sa.String(300), nullable=True),
        sa.Column('reminder_outbox_id', UUID, nullable=True),
        sa.Column('reminder_queued_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', UUID, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('party_size BETWEEN 1 AND 500', name='ck_reservations_party'),
        sa.CheckConstraint('duration_minutes BETWEEN 15 AND 720', name='ck_reservations_duration'),
        sa.CheckConstraint("status IN ('booked', 'seated', 'cancelled', 'no_show')", name='ck_reservations_status'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['table_id'], ['dining_tables.id']),
        sa.ForeignKeyConstraint(['order_id'], ['orders.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        _outlet_fk('reservations'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'client_uuid'),
    )
    _indexes('reservations', ('restaurant_id', 'outlet_id', 'table_id', 'order_id', 'created_by'))
    op.create_index('ix_reservations_outlet_starts', 'reservations', ['outlet_id', 'starts_at'])

    op.create_table(
        'attendance_records',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('client_uuid', UUID, nullable=True),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('clock_in_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('clock_out_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('clock_in_device', sa.String(100), nullable=True),
        sa.Column('clock_out_device', sa.String(100), nullable=True),
        sa.Column('geo', postgresql.JSONB(), nullable=True),
        sa.Column('source', sa.String(10), server_default='self', nullable=False),
        sa.Column('created_by', UUID, nullable=False),
        sa.Column('edited_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('edited_by', UUID, nullable=True),
        sa.Column('edit_reason', sa.String(300), nullable=True),
        sa.Column('voided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('clock_out_at IS NULL OR clock_out_at >= clock_in_at', name='ck_attendance_order'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.ForeignKeyConstraint(['edited_by'], ['users.id']),
        _outlet_fk('attendance_records'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'client_uuid'),
    )
    _indexes('attendance_records', ('restaurant_id', 'outlet_id', 'user_id', 'created_by', 'edited_by'))
    op.create_index('uq_attendance_one_open', 'attendance_records', ['user_id'], unique=True,
                    postgresql_where=sa.text('clock_out_at IS NULL AND voided_at IS NULL'))
    op.create_index('ix_attendance_rest_date', 'attendance_records', ['restaurant_id', 'work_date'])

    op.create_table(
        'attendance_schedules',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('weekday', sa.SmallInteger(), nullable=False),
        sa.Column('start_time', sa.Time(), nullable=False),
        sa.Column('end_time', sa.Time(), nullable=False),
        sa.Column('grace_minutes', sa.Integer(), server_default='10', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('weekday BETWEEN 0 AND 6', name='ck_attendance_schedules_weekday'),
        sa.CheckConstraint('grace_minutes BETWEEN 0 AND 240', name='ck_attendance_schedules_grace'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        _outlet_fk('attendance_schedules'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'outlet_id', 'weekday'),
    )
    _indexes('attendance_schedules', ('restaurant_id', 'outlet_id', 'user_id'))

    op.create_table(
        'setup_step_skips',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('step', sa.String(30), nullable=False),
        sa.Column('skipped_by', UUID, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['skipped_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'step'),
    )
    _indexes('setup_step_skips', ('restaurant_id', 'skipped_by'))

    rls.enable_tables(op.get_bind(), TABLES)


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), TABLES)
    for t in reversed(TABLES):
        op.drop_table(t)
    op.drop_column('restaurants', 'upi_vpa')
