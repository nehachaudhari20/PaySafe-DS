"""Wait for PostgreSQL and apply migrations before the API starts."""

import os
import sys
import time

from sqlalchemy import create_engine, text


def wait_for_database(url: str) -> None:
    engine = create_engine(url)
    deadline = time.time() + 60
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            engine.dispose()
            return
        except Exception as exc:  # noqa: BLE001 - retry until Postgres accepts connections
            last_error = exc
            time.sleep(1)
    raise SystemExit(f"Database was not ready: {last_error}")


def alembic_upgrade() -> None:
    from alembic.config import main as alembic_main

    alembic_main(argv=["-c", "alembic.ini", "upgrade", "head"])


def main() -> None:
    if os.environ.get("RUN_MIGRATIONS") == "1":
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise SystemExit("DATABASE_URL is required when RUN_MIGRATIONS=1.")
        wait_for_database(database_url)
        alembic_upgrade()
    if len(sys.argv) < 2:
        raise SystemExit("Expected a command to run.")
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
