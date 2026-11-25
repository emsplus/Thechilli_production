"""voice aliases: phrases the till learnt from staff corrections

New table voice_aliases: (restaurant, normalised heard phrase) -> menu item (+ option). Written when staff pick a dish for
a phrase the on-device voice parser missed and then add the order; read by every till with the menu. Deleting a menu item
deletes its phrases (ON DELETE CASCADE); a deleted option only clears variant_id (SET NULL).

Purely additive. Fully reversible (the downgrade drops the table; only the learnt phrases are lost).

Revision ID: d1f3a5c7e9b2
Revises: c9e2f4a6b8d1
Create Date: 2026-10-26 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'd1f3a5c7e9b2'
down_revision: Union[str, Sequence[str], None] = 'c9e2f4a6b8d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'voice_aliases',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('restaurant_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('phrase', sa.String(length=200), nullable=False),
        sa.Column('menu_item_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('variant_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('uses', sa.Integer(), server_default='1', nullable=False),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['menu_item_id'], ['menu_items.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['variant_id'], ['menu_variants.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('restaurant_id', 'phrase'),
    )
    op.create_index('ix_voice_aliases_restaurant_id', 'voice_aliases', ['restaurant_id'])
    op.create_index('ix_voice_aliases_menu_item_id', 'voice_aliases', ['menu_item_id'])
    op.create_index('ix_voice_aliases_created_by', 'voice_aliases', ['created_by'])


def downgrade() -> None:
    op.drop_index('ix_voice_aliases_created_by', table_name='voice_aliases')
    op.drop_index('ix_voice_aliases_menu_item_id', table_name='voice_aliases')
    op.drop_index('ix_voice_aliases_restaurant_id', table_name='voice_aliases')
    op.drop_table('voice_aliases')
