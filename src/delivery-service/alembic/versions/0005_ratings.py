"""order_ratings (rating after delivery)"""
from alembic import op
from app import models
from app.core import rls

revision = "0005"
down_revision = "0004"


def upgrade():
    bind = op.get_bind()
    models.Base.metadata.tables["order_ratings"].create(bind, checkfirst=True)
    rls.enable_tables(bind, ("order_ratings",))


def downgrade():
    bind = op.get_bind()
    rls.disable_tables(bind, ("order_ratings",))
    models.Base.metadata.tables["order_ratings"].drop(bind, checkfirst=True)
