"""SQLite-backed API client for tests."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path: Path):
    import paysafe.db as database
    from api.main import app
    from paysafe.models import Base

    database_path = (tmp_path / "payments.db").resolve().as_posix()
    database.configure_engine(f"sqlite:///{database_path}")
    assert database.engine is not None
    Base.metadata.create_all(bind=database.engine)
    with TestClient(app) as test_client:
        yield test_client
    Base.metadata.drop_all(bind=database.engine)
    database.engine.dispose()
