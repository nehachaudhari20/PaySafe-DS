"""Database engine and session helpers."""

from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from paysafe.config import get_settings

engine = None
SessionLocal: sessionmaker[Session] | None = None


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def configure_engine(url: str) -> None:
    global engine, SessionLocal
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, connect_args=connect_args, future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    if SessionLocal is None:
        configure_engine(get_settings().database_url)
    session_factory = SessionLocal
    if session_factory is None or engine is None:
        raise RuntimeError("Database is not configured.")
    session = session_factory()
    try:
        yield session
    finally:
        session.close()
