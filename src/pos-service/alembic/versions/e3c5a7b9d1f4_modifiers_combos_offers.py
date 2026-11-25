"""Modifier groups, combos and offers (docs/MODIFIERS_OFFERS.md).

* New tenant tables, each with restaurant_id and RLS (rls.MENU_EXTRA_TABLES): modifier_groups, modifier_options,
  menu_item_modifier_groups, combo_components, offers (offers.outlet_id nullable with the composite outlet FK).
* Nullable / defaulted snapshot columns: order_lines.modifiers, order_lines.components, bill_lines.modifiers, bills.offers,
  bills.offer_amount (default 0). Nothing existing is rewritten: old rows read as "no modifiers, no offers".
* Re-seeds the system roles (new permission offers.manage for owner and manager).

Downgrade drops the tables and the columns (modifier / offer snapshots on orders and bills are lost; bill totals are not).

Revision ID: e3c5a7b9d1f4
Revises: d3b8f4a6c1e7
Create Date: 2026-10-31 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import permissions, rls

revision: str = 'e3c5a7b9d1f4'
down_revision: Union[str, Sequence[str], None] = 'd3b8f4a6c1e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
TABLES = rls.MENU_EXTRA_TABLES


def _ts():
    return [sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False)]


def upgrade() -> None:
    op.create_table(
        'modifier_groups',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('min_select', sa.Integer(), server_default='0', nullable=False),
        sa.Column('max_select', sa.Integer(), server_default='1', nullable=True),
        sa.Column('sort_order', sa.Integer(), server_default='0', nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        *_ts(),
        sa.CheckConstraint('min_select >= 0', name='ck_modifier_groups_min'),
        sa.CheckConstraint('max_select IS NULL OR (max_select >= 1 AND max_select >= min_select)', name='ck_modifier_groups_max'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_modifier_groups_restaurant_id'), 'modifier_groups', ['restaurant_id'])
    op.create_table(
        'modifier_options',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('group_id', UUID, nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('price_delta_paise', sa.Integer(), server_default='0', nullable=False),
        sa.Column('is_default', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('sort_order', sa.Integer(), server_default='0', nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        *_ts(),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['group_id'], ['modifier_groups.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_modifier_options_restaurant_id'), 'modifier_options', ['restaurant_id'])
    op.create_index(op.f('ix_modifier_options_group_id'), 'modifier_options', ['group_id'])
    op.create_table(
        'menu_item_modifier_groups',
        sa.Column('item_id', UUID, nullable=False),
        sa.Column('group_id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('sort_order', sa.Integer(), server_default='0', nullable=False),
        sa.ForeignKeyConstraint(['item_id'], ['menu_items.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['group_id'], ['modifier_groups.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('item_id', 'group_id'),
    )
    op.create_index(op.f('ix_menu_item_modifier_groups_group_id'), 'menu_item_modifier_groups', ['group_id'])
    op.create_index(op.f('ix_menu_item_modifier_groups_restaurant_id'), 'menu_item_modifier_groups', ['restaurant_id'])
    op.create_table(
        'combo_components',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('combo_item_id', UUID, nullable=False),
        sa.Column('component_item_id', UUID, nullable=False),
        sa.Column('variant_id', UUID, nullable=True),
        sa.Column('quantity', sa.Integer(), server_default='1', nullable=False),
        sa.Column('sort_order', sa.Integer(), server_default='0', nullable=False),
        sa.CheckConstraint('quantity >= 1', name='ck_combo_components_qty'),
        sa.CheckConstraint('combo_item_id <> component_item_id', name='ck_combo_components_not_self'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['combo_item_id'], ['menu_items.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['component_item_id'], ['menu_items.id']),
        sa.ForeignKeyConstraint(['variant_id'], ['menu_variants.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    for col in ('restaurant_id', 'combo_item_id', 'component_item_id', 'variant_id'):
        op.create_index(op.f(f'ix_combo_components_{col}'), 'combo_components', [col])
    op.create_table(
        'offers',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('kind', sa.String(10), nullable=False),
        sa.Column('value', sa.Numeric(12, 2), nullable=False),
        sa.Column('scope', sa.String(10), server_default='bill', nullable=False),
        sa.Column('target_ids', sa.JSON(), nullable=True),
        sa.Column('min_order_value', sa.Numeric(12, 2), server_default='0', nullable=False),
        sa.Column('max_discount', sa.Numeric(12, 2), nullable=True),
        sa.Column('days_of_week', sa.JSON(), nullable=True),
        sa.Column('start_time', sa.Time(), nullable=True),
        sa.Column('end_time', sa.Time(), nullable=True),
        sa.Column('valid_from', sa.Date(), nullable=True),
        sa.Column('valid_to', sa.Date(), nullable=True),
        sa.Column('order_types', sa.JSON(), nullable=True),
        sa.Column('stackable', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('priority', sa.Integer(), server_default='0', nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('created_by', UUID, nullable=True),
        *_ts(),
        sa.CheckConstraint("kind IN ('percent', 'amount')", name='ck_offers_kind'),
        sa.CheckConstraint("scope IN ('bill', 'item', 'category')", name='ck_offers_scope'),
        sa.CheckConstraint("value > 0 AND (kind <> 'percent' OR value <= 100)", name='ck_offers_value'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.ForeignKeyConstraint(['outlet_id', 'restaurant_id'], ['outlets.id', 'outlets.restaurant_id'], name='fk_offers_outlet'),
        sa.PrimaryKeyConstraint('id'),
    )
    for col in ('restaurant_id', 'outlet_id', 'created_by'):
        op.create_index(op.f(f'ix_offers_{col}'), 'offers', [col])
    op.create_index('ix_offers_restaurant_active', 'offers', ['restaurant_id', 'is_active'])

    op.add_column('order_lines', sa.Column('modifiers', sa.JSON(none_as_null=True), nullable=True))
    op.add_column('order_lines', sa.Column('components', sa.JSON(none_as_null=True), nullable=True))
    op.add_column('bill_lines', sa.Column('modifiers', sa.JSON(none_as_null=True), nullable=True))
    op.add_column('bills', sa.Column('offer_amount', sa.Numeric(12, 2), server_default='0', nullable=False))
    op.add_column('bills', sa.Column('offers', sa.JSON(none_as_null=True), nullable=True))
    rls.enable_tables(op.get_bind(), TABLES)
    permissions.seed_system_roles(op.get_bind())


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), TABLES)
    op.drop_column('bills', 'offers')
    op.drop_column('bills', 'offer_amount')
    op.drop_column('bill_lines', 'modifiers')
    op.drop_column('order_lines', 'components')
    op.drop_column('order_lines', 'modifiers')
    for t in ('offers', 'combo_components', 'menu_item_modifier_groups', 'modifier_options', 'modifier_groups'):
        op.drop_table(t)
    op.execute("DELETE FROM role_permissions WHERE permission = 'offers.manage'")
