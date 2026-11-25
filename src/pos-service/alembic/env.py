from logging.config import fileConfig

from sqlalchemy import engine_from_config
from sqlalchemy import pool, text

from alembic import context

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
# from myapp import mymodel
# target_metadata = mymodel.Base.metadata
from app.core.config import migration_url, settings
from app.core.db_roles import ident
from app.models import Base

# MIGRATION_DATABASE_URL (the migrator login) when set, else DATABASE_URL. '%' is ConfigParser interpolation syntax.
config.set_main_option('sqlalchemy.url', migration_url(settings).replace('%', '%%'))
target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        if settings.migration_role.strip():
            context.execute(f"SET ROLE {ident(settings.migration_role.strip())}")
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        if settings.migration_role.strip():
            # Objects created below are owned by the owner role (e.g. pos_owner), not by the login role; default privileges
            # FOR ROLE pos_owner then give the app role DML on every new table. Committed so the session keeps the role and
            # Alembic starts its own transaction.
            connection.execute(text(f"SET ROLE {ident(settings.migration_role.strip())}"))
            connection.commit()
        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
