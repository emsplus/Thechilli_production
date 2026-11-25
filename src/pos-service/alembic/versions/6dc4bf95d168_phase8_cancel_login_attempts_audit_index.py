"""phase8 cancel, login attempts, audit index

Revision ID: 6dc4bf95d168
Revises: 85788690bfc9
Create Date: 2026-10-24 01:52:55.630077

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6dc4bf95d168'
down_revision: Union[str, Sequence[str], None] = '85788690bfc9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('login_attempts',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_login_attempts_email_created', 'login_attempts', ['email', 'created_at'], unique=False)
    op.create_index('ix_audit_logs_restaurant_created', 'audit_logs', ['restaurant_id', 'created_at'], unique=False)
    op.add_column('orders', sa.Column('cancel_reason', sa.String(length=300), nullable=True))
    op.add_column('orders', sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('orders', sa.Column('cancelled_by', sa.UUID(), nullable=True))
    op.create_index(op.f('ix_orders_cancelled_by'), 'orders', ['cancelled_by'], unique=False)
    op.create_foreign_key('fk_orders_cancelled_by_users', 'orders', 'users', ['cancelled_by'], ['id'])
    # Seed the gapless KOT counter (kind KOT, year 0 = never resets) from existing tickets.
    op.execute("""
        INSERT INTO invoice_sequences (id, restaurant_id, kind, year, last_number)
        SELECT gen_random_uuid(), restaurant_id, 'KOT', 0, MAX(number) FROM kot_tickets GROUP BY restaurant_id
        ON CONFLICT DO NOTHING
    """)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_orders_cancelled_by_users', 'orders', type_='foreignkey')
    op.execute("DELETE FROM invoice_sequences WHERE kind = 'KOT'")
    op.drop_index(op.f('ix_orders_cancelled_by'), table_name='orders')
    op.drop_column('orders', 'cancelled_by')
    op.drop_column('orders', 'cancelled_at')
    op.drop_column('orders', 'cancel_reason')
    op.drop_index('ix_audit_logs_restaurant_created', table_name='audit_logs')
    op.drop_index('ix_login_attempts_email_created', table_name='login_attempts')
    op.drop_table('login_attempts')
