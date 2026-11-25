"""Menu metadata: FSSAI food mark and a short description on menu items (docs/MENU_META.md).

menu_items.food_type   varchar(8) NULL, CHECK IN ('veg', 'non_veg', 'egg'); NULL = not marked (the default: nothing guessed)
menu_items.description text NULL, CHECK char_length <= 280

Additive and nullable: no existing row is rewritten, old clients (that never send the fields) keep working, and RLS is
unchanged (same table, same tenant policy). Neither column is read by KOTs, bills, pricing or tax.

Revision ID: c4e8a2f6b1d3
Revises: a7c3e9f1b2d4
Create Date: 2026-10-31 21:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c4e8a2f6b1d3'
down_revision: Union[str, Sequence[str], None] = 'a7c3e9f1b2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('menu_items', sa.Column('food_type', sa.String(length=8), nullable=True))
    op.add_column('menu_items', sa.Column('description', sa.Text(), nullable=True))
    op.create_check_constraint('ck_menu_items_food_type', 'menu_items',
                               "food_type IS NULL OR food_type IN ('veg', 'non_veg', 'egg')")
    op.create_check_constraint('ck_menu_items_description_len', 'menu_items',
                               'description IS NULL OR char_length(description) <= 280')


def downgrade() -> None:
    op.drop_constraint('ck_menu_items_description_len', 'menu_items', type_='check')
    op.drop_constraint('ck_menu_items_food_type', 'menu_items', type_='check')
    op.drop_column('menu_items', 'description')
    op.drop_column('menu_items', 'food_type')
