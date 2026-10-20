"""Alembic migration environment."""

from pathlib import Path
import sys

from alembic import context
from sqlalchemy import engine_from_config, pool

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from paysafe.config import get_settings  # noqa: E402
from paysafe.db import Base  # noqa: E402
from paysafe import models  # noqa: E402,F401

config = context.config
target_metadata = Base.metadata


def engine_configuration() -> dict:
    section = dict(config.get_section(config.config_ini_section, {}))
    section["sqlalchemy.url"] = get_settings().database_url
    return section


def run_migrations_offline() -> None:
    context.configure(
        url=get_settings().database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(engine_configuration(), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
