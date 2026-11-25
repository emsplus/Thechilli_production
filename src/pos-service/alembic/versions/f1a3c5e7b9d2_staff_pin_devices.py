"""Device sessions, counter devices, staff PINs (docs/STAFF_PIN_DEVICES_API.md).

* login_devices: signed-in devices of each user; refresh_tokens.login_device_id (nullable, SET NULL) ties a token to one.
* counter_devices: shared counter tablets of an outlet (credential stored as sha256 only), composite outlet FK.
* staff_pins, staff_pin_sessions, pin_lockouts: staff PINs (argon2 hash), PIN sessions, wrong-PIN lockouts.
* SECURITY DEFINER counter_device_by_token(text) for the pre-tenant credential lookup.
* RLS (tenant_isolation on restaurant_id) on all five tables.
* System role rows refreshed: owner and manager gain devices.manage and staff.pin.manage.

Nothing existing changes meaning: every existing refresh token keeps working (login_device_id NULL). Downgrade drops the
tables, the column, the function and the two permission rows of the system roles.

Revision ID: f1a3c5e7b9d2
Revises: b4d6f8a0c2e7
Create Date: 2026-10-31 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import definer, permissions, rls

revision: str = 'f1a3c5e7b9d2'
down_revision: Union[str, Sequence[str], None] = 'b4d6f8a0c2e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("login_devices", "counter_devices", "staff_pins", "staff_pin_sessions", "pin_lockouts")
NEW_PERMISSIONS = ("devices.manage", "staff.pin.manage")
UUID = postgresql.UUID(as_uuid=True)


def _outlet_fk(table: str):
    return sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name=f'fk_{table}_outlet')


def _user_fk(col: str = 'user_id', ondelete: str = 'CASCADE'):
    return sa.ForeignKeyConstraint([col], ['users.id'], ondelete=ondelete)


def _indexes(table: str, cols) -> None:
    for col in cols:
        op.create_index(op.f(f'ix_{table}_{col}'), table, [col])


def upgrade() -> None:
    op.create_table(
        'login_devices',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('device_key', sa.String(100), nullable=False),
        sa.Column('name', sa.String(100), nullable=True),
        sa.Column('model', sa.String(100), nullable=True),
        sa.Column('platform', sa.String(30), nullable=True),
        sa.Column('user_agent', sa.String(300), nullable=True),
        sa.Column('first_seen_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_ip', sa.String(64), nullable=True),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_by', UUID, nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        _user_fk(),
        _user_fk('revoked_by', 'SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'device_key', name='uq_login_devices_user_key'),
    )
    _indexes('login_devices', ('restaurant_id', 'user_id'))
    op.create_index('ix_login_devices_rest_seen', 'login_devices', ['restaurant_id', 'last_seen_at'])

    op.add_column('refresh_tokens', sa.Column('login_device_id', UUID, nullable=True))
    op.create_foreign_key('refresh_tokens_login_device_id_fkey', 'refresh_tokens', 'login_devices', ['login_device_id'], ['id'],
                          ondelete='SET NULL')
    op.create_index(op.f('ix_refresh_tokens_login_device_id'), 'refresh_tokens', ['login_device_id'])

    op.create_table(
        'counter_devices',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('token_hash', sa.String(64), nullable=False),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_ip', sa.String(64), nullable=True),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_by', UUID, nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        _user_fk('created_by', 'SET NULL'),
        _user_fk('revoked_by', 'SET NULL'),
        _outlet_fk('counter_devices'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    _indexes('counter_devices', ('restaurant_id', 'outlet_id'))

    op.create_table(
        'staff_pins',
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('pin_hash', sa.String(255), nullable=False),
        sa.Column('scheme', sa.String(20), nullable=False),
        sa.Column('set_by', UUID, nullable=True),
        sa.Column('set_by_manager', sa.Boolean(), nullable=False),
        sa.Column('set_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        _user_fk(),
        _user_fk('set_by', 'SET NULL'),
        sa.PrimaryKeyConstraint('user_id'),
    )
    _indexes('staff_pins', ('restaurant_id',))

    op.create_table(
        'staff_pin_sessions',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=False),
        sa.Column('counter_device_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_activity_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('end_reason', sa.String(30), nullable=True),
        sa.Column('ip', sa.String(64), nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['counter_device_id'], ['counter_devices.id'], ondelete='CASCADE'),
        _user_fk(),
        _outlet_fk('staff_pin_sessions'),
        sa.PrimaryKeyConstraint('id'),
    )
    _indexes('staff_pin_sessions', ('restaurant_id', 'outlet_id', 'counter_device_id', 'user_id'))
    op.create_index('ix_staff_pin_sessions_device_open', 'staff_pin_sessions', ['counter_device_id'],
                    postgresql_where=sa.text('ended_at IS NULL'))

    op.create_table(
        'pin_lockouts',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('scope_key', sa.String(64), nullable=False),
        sa.Column('failures', sa.Integer(), nullable=False),
        sa.Column('lock_level', sa.Integer(), nullable=False),
        sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_failure_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        _user_fk(),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'scope_key', name='uq_pin_lockouts_user_scope'),
    )
    _indexes('pin_lockouts', ('restaurant_id', 'user_id'))

    rls.enable_tables(op.get_bind(), TABLES)

    args, sql = definer.FUNCTIONS["counter_device_by_token"]
    op.execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION counter_device_by_token({args}) FROM PUBLIC")

    permissions.seed_system_roles(op.get_bind())  # owner / manager rows gain the two new permissions


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission = ANY(:p) AND role_id IN "
                         "(SELECT id FROM roles WHERE restaurant_id IS NULL)"), {"p": list(NEW_PERMISSIONS)})
    op.execute("DROP FUNCTION IF EXISTS counter_device_by_token(text)")
    rls.disable_tables(bind, TABLES)
    op.drop_index(op.f('ix_refresh_tokens_login_device_id'), table_name='refresh_tokens')
    op.drop_constraint('refresh_tokens_login_device_id_fkey', 'refresh_tokens', type_='foreignkey')
    op.drop_column('refresh_tokens', 'login_device_id')
    for t in ("pin_lockouts", "staff_pin_sessions", "staff_pins", "counter_devices", "login_devices"):
        op.drop_table(t)
