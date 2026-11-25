"""provisioning workflow state on onboarding applications

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('onboarding_applications', sa.Column('provision_state', sa.String(length=16), nullable=True))
    op.add_column('onboarding_applications', sa.Column('provision_next_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('onboarding_applications', sa.Column('provision_error_code', sa.String(length=48), nullable=True))
    op.add_column('onboarding_applications', sa.Column('owner_invited_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('onboarding_applications', sa.Column('live_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('onboarding_applications', sa.Column('invite_sends', sa.Integer(), server_default='0', nullable=False))
    op.create_check_constraint('ck_app_provision_state', 'onboarding_applications',
                               "provision_state is null or provision_state in ('queued','provisioning','owner_invited','live','failed')")
    op.create_index('ix_app_provision_due', 'onboarding_applications', ['provision_state', 'provision_next_at'])
    # Backfill: applications that finished under the old stub flow are live; failed/approved/provisioning map onto the new states.
    op.execute("update onboarding_applications set provision_state = 'live', live_at = updated_at where status = 'provisioned'")
    op.execute("update onboarding_applications set provision_state = 'failed' where status = 'failed'")
    op.execute("update onboarding_applications set provision_state = 'queued' where status = 'approved'")
    op.execute("update onboarding_applications set provision_state = 'provisioning' where status = 'provisioning'")


def downgrade() -> None:
    op.drop_index('ix_app_provision_due', table_name='onboarding_applications')
    op.drop_constraint('ck_app_provision_state', 'onboarding_applications', type_='check')
    for c in ('invite_sends', 'live_at', 'owner_invited_at', 'provision_error_code', 'provision_next_at', 'provision_state'):
        op.drop_column('onboarding_applications', c)
