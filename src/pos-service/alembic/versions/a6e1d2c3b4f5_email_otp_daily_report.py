"""Email (docs/EMAIL.md): email_otps (global, no RLS: sign-up and password-reset one-time codes), daily_report_emails (RLS:
end of day report ledger, one row per outlet and business date), the restaurant's daily report settings, the users' opt-in and
the SECURITY DEFINER lookup daily_report_tenants.

Revision ID: a6e1d2c3b4f5
Revises: 5ec1a0b1c2d6
Create Date: 2026-10-31 22:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import definer, rls

revision: str = 'a6e1d2c3b4f5'
down_revision: Union[str, Sequence[str], None] = '5ec1a0b1c2d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_FUNCTIONS = ("daily_report_tenants",)
_TABLES = ("daily_report_emails",)


def upgrade() -> None:
    op.add_column('restaurants', sa.Column('daily_report_email', sa.Boolean(), server_default='true', nullable=False))
    op.add_column('restaurants', sa.Column('daily_report_time', sa.String(5), server_default='23:00', nullable=False))
    op.add_column('restaurants', sa.Column('daily_report_on_close', sa.Boolean(), server_default='true', nullable=False))
    op.add_column('users', sa.Column('daily_report_opt_in', sa.Boolean(), server_default='false', nullable=False))
    op.create_table(
        'email_otps',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('purpose', sa.String(20), nullable=False),
        sa.Column('email', sa.String(254), nullable=False),
        sa.Column('code_hash', sa.String(64), nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('consumed_at', sa.DateTime(timezone=True)),
        sa.Column('sends', sa.Integer(), server_default='1', nullable=False),
        sa.Column('last_sent_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('payload', postgresql.JSONB()),
        sa.Column('grant_hash', sa.String(64)),
        sa.Column('grant_expires_at', sa.DateTime(timezone=True)),
        sa.Column('grant_used_at', sa.DateTime(timezone=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False))
    op.create_index('ix_email_otps_purpose_email', 'email_otps', ['purpose', 'email'])
    op.create_index('ix_email_otps_expires_at', 'email_otps', ['expires_at'])
    op.create_table(
        'daily_report_emails',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('restaurants.id'), nullable=False),
        sa.Column('outlet_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('business_date', sa.Date(), nullable=False),
        sa.Column('trigger', sa.String(10), nullable=False),
        sa.Column('status', sa.String(10), server_default='queued', nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('recipients', sa.Integer(), server_default='0', nullable=False),
        sa.Column('error', sa.String(300)),
        sa.Column('z_report_id', postgresql.UUID(as_uuid=True)),
        sa.Column('sent_at', sa.DateTime(timezone=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.UniqueConstraint('outlet_id', 'business_date', name='uq_daily_report_emails_outlet_date'),
        sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'],
                                name='fk_daily_report_emails_outlet'))
    op.create_index('ix_daily_report_emails_restaurant_id', 'daily_report_emails', ['restaurant_id'])
    op.create_index('ix_daily_report_emails_outlet_id', 'daily_report_emails', ['outlet_id'])
    op.create_index('ix_daily_report_emails_due', 'daily_report_emails', ['status', 'updated_at'],
                    postgresql_where=sa.text("status = 'queued'"))
    bind = op.get_bind()
    rls.enable_tables(bind, _TABLES)
    for name in _NEW_FUNCTIONS:
        args, sql = definer.FUNCTIONS[name]
        bind.execute(sa.text(sql))
        bind.execute(sa.text(f"REVOKE ALL ON FUNCTION {name}({args}) FROM PUBLIC"))


def downgrade() -> None:
    bind = op.get_bind()
    for name in _NEW_FUNCTIONS:
        bind.execute(sa.text(f"DROP FUNCTION IF EXISTS {name}({definer.FUNCTIONS[name][0]})"))
    rls.disable_tables(bind, _TABLES)
    op.drop_table('daily_report_emails')
    op.drop_table('email_otps')
    op.drop_column('users', 'daily_report_opt_in')
    op.drop_column('restaurants', 'daily_report_on_close')
    op.drop_column('restaurants', 'daily_report_time')
    op.drop_column('restaurants', 'daily_report_email')
