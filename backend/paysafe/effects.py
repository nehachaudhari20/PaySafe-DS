"""Claim and complete one simulated payment effect per transaction id."""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from paysafe.db import utcnow
from paysafe.models import FAILED, PROCESSING, SUCCESS, WorkerEffect

TERMINAL = {SUCCESS, FAILED}


def get_effect(db: Session, transaction_id: str) -> WorkerEffect | None:
    return db.scalar(select(WorkerEffect).where(WorkerEffect.transaction_id == transaction_id))


def claim_effect(session_factory: sessionmaker[Session], transaction_id: str, worker_id: str) -> tuple[bool, WorkerEffect]:
    """Return `(owns_effect, row)`.

    The caller performs the simulated effect only when `owns_effect` is true.
    A unique transaction id makes a concurrent claim return the winner's row.
    """

    session = session_factory()
    try:
        existing = session.scalar(select(WorkerEffect).where(WorkerEffect.transaction_id == transaction_id))
        if existing is not None:
            session.expunge(existing)
            return False, existing
        now = utcnow()
        row = WorkerEffect(
            transaction_id=transaction_id,
            status=PROCESSING,
            worker_id=worker_id,
            message="Effect claimed.",
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            winner = session.scalar(select(WorkerEffect).where(WorkerEffect.transaction_id == transaction_id))
            if winner is None:
                raise
            session.expunge(winner)
            return False, winner
        session.refresh(row)
        session.expunge(row)
        return True, row
    finally:
        session.close()


def complete_effect(
    session_factory: sessionmaker[Session],
    transaction_id: str,
    worker_id: str,
    status: str,
    message: str,
) -> WorkerEffect | None:
    """Store a terminal result. A row that is already SUCCESS or FAILED is left as it is."""

    if status not in TERMINAL:
        raise ValueError("Effect status must be SUCCESS or FAILED.")
    session = session_factory()
    try:
        row = session.scalar(select(WorkerEffect).where(WorkerEffect.transaction_id == transaction_id))
        if row is None:
            return None
        if row.status not in TERMINAL:
            row.status = status
            row.worker_id = worker_id
            row.message = message[:300]
            row.updated_at = utcnow()
            session.commit()
            session.refresh(row)
        session.expunge(row)
        return row
    finally:
        session.close()
