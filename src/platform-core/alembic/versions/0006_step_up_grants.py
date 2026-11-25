"""per-action step-up grants (docs/STEP_UP.md): short-lived, session-bound proof of a fresh second factor.

Revision ID: 0006
Revises: 0005
"""
import sqlalchemy as sa

from alembic import op

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('step_up_grants',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('staff_id', sa.UUID(), nullable=False),
        sa.Column('session_id', sa.UUID(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('method', sa.String(length=16), nullable=False),
        sa.Column('uses_left', sa.Integer(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ip', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'))
    op.create_index(op.f('ix_step_up_grants_staff_id'), 'step_up_grants', ['staff_id'])
    op.create_index(op.f('ix_step_up_grants_expires_at'), 'step_up_grants', ['expires_at'])


def downgrade() -> None:
    op.drop_index(op.f('ix_step_up_grants_expires_at'), table_name='step_up_grants')
    op.drop_index(op.f('ix_step_up_grants_staff_id'), table_name='step_up_grants')
    op.drop_table('step_up_grants')
