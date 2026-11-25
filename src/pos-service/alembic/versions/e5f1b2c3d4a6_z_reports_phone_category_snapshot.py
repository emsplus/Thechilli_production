"""End-of-day Z reports: z_reports table, restaurant phone + first Z number, bill/category snapshots

All new columns are nullable or defaulted; existing rows and clients are unaffected.

Revision ID: e5f1b2c3d4a6
Revises: d4e8a1b7c9f2
Create Date: 2026-10-25 16:14:02.104688

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5f1b2c3d4a6'
down_revision: Union[str, Sequence[str], None] = 'd4e8a1b7c9f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('z_reports',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('restaurant_id', sa.UUID(), nullable=False),
    sa.Column('number', sa.Integer(), nullable=False),
    sa.Column('period_from', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period_to', sa.DateTime(timezone=True), nullable=False),
    sa.Column('closed_by', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('idempotency_key', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['closed_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('restaurant_id', 'idempotency_key'),
    sa.UniqueConstraint('restaurant_id', 'number')
    )
    op.create_index(op.f('ix_z_reports_closed_by'), 'z_reports', ['closed_by'], unique=False)
    op.create_index(op.f('ix_z_reports_restaurant_id'), 'z_reports', ['restaurant_id'], unique=False)
    op.add_column('bill_lines', sa.Column('category_name', sa.String(length=100), nullable=True))
    op.add_column('bills', sa.Column('seller_phone', sa.String(length=30), nullable=True))
    op.create_index('ix_bills_restaurant_finalized', 'bills', ['restaurant_id', 'finalized_at'], unique=False)
    op.add_column('restaurants', sa.Column('phone', sa.String(length=30), nullable=True))
    op.add_column('restaurants', sa.Column('z_report_next_number', sa.Integer(), server_default='1', nullable=False))


def downgrade() -> None:
    op.drop_column('restaurants', 'z_report_next_number')
    op.drop_column('restaurants', 'phone')
    op.drop_index('ix_bills_restaurant_finalized', table_name='bills')
    op.drop_column('bills', 'seller_phone')
    op.drop_column('bill_lines', 'category_name')
    op.drop_index(op.f('ix_z_reports_restaurant_id'), table_name='z_reports')
    op.drop_index(op.f('ix_z_reports_closed_by'), table_name='z_reports')
    op.drop_table('z_reports')
