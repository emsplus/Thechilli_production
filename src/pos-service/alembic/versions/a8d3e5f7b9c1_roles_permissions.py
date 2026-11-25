"""PR 8 (docs/PERMISSIONS.md): roles, role_permissions, users.custom_role_id (RLS) and the five seeded system roles.

System roles (restaurant_id NULL) are seeded from app/core/permissions.py as it is when this revision runs; the code dict stays
authoritative for them. Existing users keep their enum role (custom_role_id NULL), so behaviour is unchanged.
Downgrade drops the column and both tables (custom roles are lost; users fall back to their enum role).

Revision ID: a8d3e5f7b9c1
Revises: f9c6b7d8e0a1
Create Date: 2026-10-30 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import permissions, rls


revision: str = 'a8d3e5f7b9c1'
down_revision: Union[str, Sequence[str], None] = 'f9c6b7d8e0a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'roles',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('key', sa.String(length=60), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('is_system', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_roles_restaurant_id'), 'roles', ['restaurant_id'], unique=False)
    op.create_index('uq_roles_system_key', 'roles', ['key'], unique=True, postgresql_where=sa.text('restaurant_id IS NULL'))
    op.create_index('uq_roles_tenant_key', 'roles', ['restaurant_id', 'key'], unique=True,
                    postgresql_where=sa.text('restaurant_id IS NOT NULL'))
    op.create_table(
        'role_permissions',
        sa.Column('role_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('permission', sa.String(length=60), nullable=False),
        sa.ForeignKeyConstraint(['role_id'], ['roles.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('role_id', 'permission'),
    )
    op.add_column('users', sa.Column('custom_role_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index(op.f('ix_users_custom_role_id'), 'users', ['custom_role_id'], unique=False)
    op.create_foreign_key('fk_users_custom_role_id', 'users', 'roles', ['custom_role_id'], ['id'])
    bind = op.get_bind()
    rls.enable_permission_tables(bind)
    permissions.seed_system_roles(bind)


def downgrade() -> None:
    bind = op.get_bind()
    rls.disable_permission_tables(bind)
    op.drop_constraint('fk_users_custom_role_id', 'users', type_='foreignkey')
    op.drop_index(op.f('ix_users_custom_role_id'), table_name='users')
    op.drop_column('users', 'custom_role_id')
    op.drop_table('role_permissions')
    op.drop_index('uq_roles_tenant_key', table_name='roles')
    op.drop_index('uq_roles_system_key', table_name='roles')
    op.drop_index(op.f('ix_roles_restaurant_id'), table_name='roles')
    op.drop_table('roles')
