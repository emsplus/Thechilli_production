from logging.config import fileConfig

from sqlalchemy import create_engine, pool

import app.models  # noqa: F401
from alembic import context
from app.core.config import settings
from app.core.db import Base

config = context.config
fileConfig(config.config_file_name)
target_metadata = Base.metadata

with create_engine(settings.database_url, poolclass=pool.NullPool).connect() as conn:
    context.configure(connection=conn, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()
