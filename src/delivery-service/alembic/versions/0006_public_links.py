"""public_links (per-restaurant public ordering link) + resolve_public_link()"""
from alembic import op
from app import models
from app.core import rls

revision = "0006"
down_revision = "0005"


def upgrade():
    bind = op.get_bind()
    models.Base.metadata.tables["public_links"].create(bind, checkfirst=True)
    rls.enable_tables(bind, ("public_links",))
    rls.create_public_link_fn(bind)


def downgrade():
    bind = op.get_bind()
    op.execute("DROP FUNCTION IF EXISTS resolve_public_link(text)")
    rls.disable_tables(bind, ("public_links",))
    models.Base.metadata.tables["public_links"].drop(bind, checkfirst=True)
