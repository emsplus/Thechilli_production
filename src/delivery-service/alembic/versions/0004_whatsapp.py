"""WhatsApp: rate buckets, opt-out state, delivery status receipts"""
from alembic import op
from app import models
from app.core import rls

revision = "0004"
down_revision = "0003"
TABLES = ("rate_buckets", "wa_consents", "message_statuses")


def upgrade():
    bind = op.get_bind()
    for t in TABLES:
        models.Base.metadata.tables[t].create(bind, checkfirst=True)
    rls.enable_tables(bind, TABLES)


def downgrade():
    bind = op.get_bind()
    rls.disable_tables(bind, TABLES)
    for t in reversed(TABLES):
        models.Base.metadata.tables[t].drop(bind, checkfirst=True)
