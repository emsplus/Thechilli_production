"""Row Level Security on every tenant table, app_tenant(), resolve_channel(), grants to the app role"""
from alembic import op
from app.core import rls

revision = "0002"
down_revision = "0001"


def upgrade():
    bind = op.get_bind()
    rls.enable_direct(bind, rls.DIRECT_TABLES_V1)  # frozen set: later tables are enabled by their own revisions
    rls.enable_children(bind)
    rls.grant_app_role(bind)


def downgrade():
    rls.disable_all(op.get_bind())
