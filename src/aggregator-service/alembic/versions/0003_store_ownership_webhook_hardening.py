"""store ownership proof, per-store webhook secret refs, webhook replay table

Existing mappings are marked UNVERIFIED and carry a placeholder secret ref that cannot resolve, so they receive
nothing until the tenant re-registers a secret ref and proves ownership (or an admin claims the store).

Revision ID: 0003
Revises: 0002
"""
import sqlalchemy as sa

from alembic import op

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('store_mappings', sa.Column('webhook_secret_ref', sa.String(length=64), nullable=False,
                                              server_default='UNCONFIGURED'))
    op.alter_column('store_mappings', 'webhook_secret_ref', server_default=None)
    op.add_column('store_mappings', sa.Column('verified', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.alter_column('store_mappings', 'verified', server_default=None)
    op.add_column('store_mappings', sa.Column('verification_code', sa.String(length=64), nullable=True))
    op.add_column('store_mappings', sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True))
    op.drop_constraint('store_mappings_provider_external_store_id_key', 'store_mappings', type_='unique')
    op.create_unique_constraint(None, 'store_mappings', ['tenant_id', 'provider', 'external_store_id'])
    op.create_index('uq_store_verified_owner', 'store_mappings', ['provider', 'external_store_id'], unique=True,
                    postgresql_where=sa.text('verified'))
    op.create_table('webhook_replays',
                    sa.Column('id', sa.String(length=64), nullable=False),
                    sa.Column('seen_at', sa.DateTime(timezone=True), nullable=False),
                    sa.PrimaryKeyConstraint('id'))
    op.create_index(op.f('ix_webhook_replays_seen_at'), 'webhook_replays', ['seen_at'], unique=False)


def downgrade() -> None:
    op.drop_table('webhook_replays')
    op.drop_index('uq_store_verified_owner', table_name='store_mappings')
    op.drop_constraint('store_mappings_tenant_id_provider_external_store_id_key', 'store_mappings', type_='unique')
    op.create_unique_constraint('store_mappings_provider_external_store_id_key', 'store_mappings',
                                ['provider', 'external_store_id'])
    for c in ('verified_at', 'verification_code', 'verified', 'webhook_secret_ref'):
        op.drop_column('store_mappings', c)
