"""staff MFA (TOTP), session metadata, plan versions

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('refresh_tokens', sa.Column('ip', sa.String(length=64), nullable=True))
    op.add_column('refresh_tokens', sa.Column('user_agent', sa.String(length=300), nullable=True))
    op.add_column('refresh_tokens', sa.Column('mfa', sa.Boolean(), server_default=sa.text('false'), nullable=False))
    op.create_table('staff_mfa',
        sa.Column('staff_id', sa.UUID(), nullable=False),
        sa.Column('secret_enc', sa.Text(), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_step', sa.BigInteger(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id']),
        sa.PrimaryKeyConstraint('staff_id'))
    op.create_table('mfa_recovery_codes',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('staff_id', sa.UUID(), nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id']),
        sa.PrimaryKeyConstraint('id'))
    op.create_index(op.f('ix_mfa_recovery_codes_staff_id'), 'mfa_recovery_codes', ['staff_id'])
    op.create_table('mfa_attempts',
        sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column('staff_id', sa.UUID(), nullable=False),
        sa.Column('ip', sa.String(length=64), nullable=False),
        sa.Column('success', sa.Boolean(), nullable=False),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'))
    op.create_index(op.f('ix_mfa_attempts_staff_id'), 'mfa_attempts', ['staff_id'])
    op.create_index(op.f('ix_mfa_attempts_at'), 'mfa_attempts', ['at'])
    op.add_column('plans', sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False))
    op.add_column('plans', sa.Column('retired_at', sa.DateTime(timezone=True), nullable=True))
    op.create_table('plan_versions',
        sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column('plan_id', sa.UUID(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('change', sa.String(length=24), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('actor', sa.String(length=100), nullable=False),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['plan_id'], ['plans.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('plan_id', 'version', name='uq_plan_version'))
    op.create_index(op.f('ix_plan_versions_plan_id'), 'plan_versions', ['plan_id'])
    op.execute("CREATE TRIGGER plan_versions_append_only BEFORE UPDATE OR DELETE ON plan_versions "
               "FOR EACH ROW EXECUTE FUNCTION forbid_mutation()")
    # Existing plans get a version-1 snapshot so history starts complete.
    op.execute("""INSERT INTO plan_versions (plan_id, version, snapshot, change, actor, at)
        SELECT p.id, 1, jsonb_build_object('code', p.code, 'name', p.name, 'description', p.description,
            'price_paise', p.price_paise, 'billing_period', p.billing_period, 'is_active', p.is_active,
            'features', COALESCE((SELECT jsonb_agg(jsonb_build_object('feature_code', f.feature_code, 'enabled', f.enabled,
                'limit_value', f.limit_value) ORDER BY f.feature_code) FROM plan_features f WHERE f.plan_id = p.id), '[]'::jsonb)),
            'created', 'migration', now() FROM plans p""")


def downgrade() -> None:
    op.drop_table('plan_versions')
    op.drop_column('plans', 'retired_at')
    op.drop_column('plans', 'version')
    op.drop_table('mfa_attempts')
    op.drop_table('mfa_recovery_codes')
    op.drop_table('staff_mfa')
    op.drop_column('refresh_tokens', 'mfa')
    op.drop_column('refresh_tokens', 'user_agent')
    op.drop_column('refresh_tokens', 'ip')
