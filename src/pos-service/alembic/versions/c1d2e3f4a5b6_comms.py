"""Communications (docs/COMMS.md): password_reset_tokens and whatsapp_outbox (RLS), whatsapp_contacts (global, no RLS), the two
tenant settings (both default off) and the SECURITY DEFINER lookups auth_find_reset_users / whatsapp_due_work.

Revision ID: c1d2e3f4a5b6
Revises: c7a9e1b3d5f8
Create Date: 2026-10-30 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import definer, rls

revision: str = 'c1d2e3f4a5b6'
down_revision: Union[str, Sequence[str], None] = 'c7a9e1b3d5f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_FUNCTIONS = ("auth_find_reset_users", "whatsapp_due_work")
_TABLES = ("password_reset_tokens", "whatsapp_outbox")


def _uuid_pk():
    return sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True)


def upgrade() -> None:
    op.add_column('restaurants', sa.Column('login_alert_emails', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('restaurants', sa.Column('whatsapp_enabled', sa.Boolean(), server_default='false', nullable=False))
    op.create_table(
        'password_reset_tokens', _uuid_pk(),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('restaurants.id'), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('token_hash', sa.String(64), nullable=False, unique=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False))
    op.create_index('ix_password_reset_tokens_restaurant_id', 'password_reset_tokens', ['restaurant_id'])
    op.create_index('ix_password_reset_tokens_user_id', 'password_reset_tokens', ['user_id'])
    op.create_table(
        'whatsapp_outbox', _uuid_pk(),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('restaurants.id'), nullable=False),
        sa.Column('kind', sa.String(20), nullable=False),
        sa.Column('mode', sa.String(10), nullable=False),
        sa.Column('to_phone', sa.String(20), nullable=False),
        sa.Column('template', sa.String(80)),
        sa.Column('language', sa.String(10)),
        sa.Column('variables', postgresql.JSONB(), nullable=False, server_default='[]'),
        sa.Column('body', sa.Text()),
        sa.Column('bill_id', postgresql.UUID(as_uuid=True)),
        sa.Column('status', sa.String(10), server_default='queued', nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('next_attempt_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('last_error', sa.String(500)),
        sa.Column('provider_message_id', sa.String(100)),
        sa.Column('sent_at', sa.DateTime(timezone=True)),
        sa.Column('dedupe_key', sa.String(100)),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id')),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.UniqueConstraint('restaurant_id', 'dedupe_key'))
    op.create_index('ix_whatsapp_outbox_restaurant_id', 'whatsapp_outbox', ['restaurant_id'])
    op.create_index('ix_whatsapp_outbox_created_by', 'whatsapp_outbox', ['created_by'])
    op.create_index('ix_whatsapp_outbox_next_attempt_at', 'whatsapp_outbox', ['next_attempt_at'])
    op.create_table(
        'whatsapp_contacts',
        sa.Column('phone', sa.String(20), primary_key=True),
        sa.Column('opted_out_at', sa.DateTime(timezone=True)),
        sa.Column('last_inbound_at', sa.DateTime(timezone=True)))
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
    op.drop_table('whatsapp_contacts')
    op.drop_table('whatsapp_outbox')
    op.drop_table('password_reset_tokens')
    op.drop_column('restaurants', 'whatsapp_enabled')
    op.drop_column('restaurants', 'login_alert_emails')
