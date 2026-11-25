"""revoked_tokens (individual token revocation by jti)"""
from alembic import op
from app import models
from app.core import rls

revision = "0003"
down_revision = "0002"


def upgrade():
    bind = op.get_bind()
    models.Base.metadata.tables["revoked_tokens"].create(bind, checkfirst=True)
    rls.enable_tables(bind, ("revoked_tokens",))


def downgrade():
    bind = op.get_bind()
    rls.disable_tables(bind, ("revoked_tokens",))
    models.Base.metadata.tables["revoked_tokens"].drop(bind, checkfirst=True)
