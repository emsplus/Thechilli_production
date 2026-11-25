"""table QR codes and guest reviews (docs/TABLE_QR_REVIEWS.md)

Three new tenant tables (RLS via rls.TABLE_QR_TABLES; default privileges give pos_app DML as for every table the owner role
creates):
* table_qr_settings (PK restaurant_id): menu QR / reviews switches, optional Google review link, generation of the
  restaurant-wide QR codes.
* table_qr_links (PK table_id): generation of a table's QR codes after "Regenerate" (no row = generation 1).
* table_reviews: rating 1-5 (CHECK), optional comment (<= 500 chars, CHECK), optional guest name / contact, table id and a
  label snapshot from the signed QR token, read_at for the owner's bell. Indexes (restaurant_id, created_at) for the newest-first
  list and (restaurant_id, table_id) for the per-table filter.

Purely additive, nothing existing is changed. Fully reversible (the downgrade drops the three tables; reviews are lost).

Revision ID: c5e7a9b1d3f6
Revises: b8d2f4a6c0e3
Create Date: 2026-11-02 14:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.core import rls

revision: str = 'c5e7a9b1d3f6'
down_revision: Union[str, Sequence[str], None] = 'b8d2f4a6c0e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)
TABLES = ("table_qr_settings", "table_qr_links", "table_reviews")  # frozen copy of rls.TABLE_QR_TABLES


def upgrade() -> None:
    op.create_table(
        'table_qr_settings',
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('menu_enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False),
        sa.Column('reviews_enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False),
        sa.Column('google_review_url', sa.String(length=500), nullable=True),
        sa.Column('general_gen', sa.Integer(), server_default=sa.text('1'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('restaurant_id'),
    )
    op.create_table(
        'table_qr_links',
        sa.Column('table_id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('gen', sa.Integer(), server_default=sa.text('1'), nullable=False),
        sa.Column('rotated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('gen BETWEEN 1 AND 65535', name='ck_table_qr_links_gen'),
        sa.ForeignKeyConstraint(['table_id'], ['dining_tables.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.PrimaryKeyConstraint('table_id'),
    )
    op.create_index('ix_table_qr_links_restaurant_id', 'table_qr_links', ['restaurant_id'])
    op.create_table(
        'table_reviews',
        sa.Column('id', UUID, nullable=False),
        sa.Column('restaurant_id', UUID, nullable=False),
        sa.Column('outlet_id', UUID, nullable=True),
        sa.Column('table_id', UUID, nullable=True),
        sa.Column('table_label', sa.String(length=50), nullable=True),
        sa.Column('rating', sa.SmallInteger(), nullable=False),
        sa.Column('comment', sa.String(length=500), nullable=True),
        sa.Column('guest_name', sa.String(length=80), nullable=True),
        sa.Column('guest_contact', sa.String(length=120), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint('rating BETWEEN 1 AND 5', name='ck_table_reviews_rating'),
        sa.CheckConstraint('comment IS NULL OR char_length(comment) <= 500', name='ck_table_reviews_comment_len'),
        sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id']),
        sa.ForeignKeyConstraint(['table_id'], ['dining_tables.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_table_reviews_rest_created', 'table_reviews', ['restaurant_id', 'created_at'])
    op.create_index('ix_table_reviews_rest_table', 'table_reviews', ['restaurant_id', 'table_id'])
    rls.enable_tables(op.get_bind(), TABLES)


def downgrade() -> None:
    rls.disable_tables(op.get_bind(), TABLES)
    op.drop_index('ix_table_reviews_rest_table', table_name='table_reviews')
    op.drop_index('ix_table_reviews_rest_created', table_name='table_reviews')
    op.drop_table('table_reviews')
    op.drop_index('ix_table_qr_links_restaurant_id', table_name='table_qr_links')
    op.drop_table('table_qr_links')
    op.drop_table('table_qr_settings')
