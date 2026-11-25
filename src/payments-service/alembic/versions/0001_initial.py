"""initial schema"""
from alembic import op
from app import models
from app.ddl import APPEND_ONLY_SQL

revision = "0001"
down_revision = None


def upgrade():
    models.Base.metadata.create_all(op.get_bind())  # frozen to the v1 schema; later revisions use explicit ops
    op.execute(APPEND_ONLY_SQL)


def downgrade():
    models.Base.metadata.drop_all(op.get_bind())
    op.execute("DROP FUNCTION IF EXISTS forbid_mutation()")
