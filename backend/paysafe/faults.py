"""Development-only worker fault switches stored in PostgreSQL."""

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from paysafe.config import get_settings
from paysafe.db import utcnow
from paysafe.models import WorkerFault

FAULT_MODES = {"normal", "fail", "delay"}


def get_fault(session_factory: sessionmaker[Session], worker_id: str) -> tuple[str, float]:
    if not get_settings().fault_injection_enabled:
        return "normal", 0.0
    session = session_factory()
    try:
        row = session.get(WorkerFault, worker_id)
        if row is None:
            return "normal", 0.0
        return row.mode, float(row.delay_seconds)
    finally:
        session.close()


def upsert_fault(db: Session, worker_id: str, mode: str, delay_seconds: float) -> WorkerFault:
    if mode not in FAULT_MODES:
        raise ValueError("Fault mode must be normal, fail, or delay.")
    if delay_seconds < 0 or delay_seconds > 30:
        raise ValueError("Fault delay must be between 0 and 30 seconds.")
    row = db.get(WorkerFault, worker_id)
    now = utcnow()
    if row is None:
        row = WorkerFault(worker_id=worker_id, mode=mode, delay_seconds=delay_seconds, updated_at=now)
        db.add(row)
    else:
        row.mode = mode
        row.delay_seconds = delay_seconds
        row.updated_at = now
    db.commit()
    db.refresh(row)
    return row


def list_faults(db: Session) -> list[WorkerFault]:
    return list(db.scalars(select(WorkerFault).order_by(WorkerFault.worker_id)).all())
