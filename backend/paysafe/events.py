"""Persist and read the execution history for one payment."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from paysafe.db import utcnow
from paysafe.models import PaymentEvent

EVENT_TYPES = {
    "PAYMENT_RECEIVED",
    "WORKER_SELECTED",
    "ATTEMPT_STARTED",
    "ATTEMPT_RETRIED",
    "WORKER_RESULT_RECEIVED",
    "WORKER_UNAVAILABLE",
    "PAYMENT_MARKED_UNKNOWN",
    "PAYMENT_SUCCEEDED",
    "PAYMENT_FAILED",
    "RECONCILIATION_STARTED",
    "RECONCILIATION_RESOLVED",
    "RECONCILIATION_INCONCLUSIVE",
    "COORDINATOR_TIMEOUT",
}

COORDINATOR_EVENT_TYPES = {
    "WORKER_SELECTED",
    "ATTEMPT_STARTED",
    "ATTEMPT_RETRIED",
    "WORKER_RESULT_RECEIVED",
    "WORKER_UNAVAILABLE",
}


def add_event(
    db: Session,
    transaction_id: str,
    event_type: str,
    message: str,
    *,
    service: str,
    worker_id: str | None = None,
    attempt: int | None = None,
    lamport_time: int | None = None,
    details: dict | None = None,
) -> PaymentEvent:
    """Stage an event. The caller commits it with the payment change."""

    if event_type not in EVENT_TYPES:
        raise ValueError(f"Unknown event type {event_type}.")
    safe_details = _safe_details(details)
    row = PaymentEvent(
        transaction_id=transaction_id,
        event_type=event_type,
        created_at=utcnow(),
        service=service[:32],
        worker_id=worker_id[:64] if worker_id else None,
        attempt=attempt if isinstance(attempt, int) and attempt >= 0 else None,
        lamport_time=lamport_time if isinstance(lamport_time, int) and lamport_time > 0 else None,
        message=(message or "")[:300],
        details=safe_details,
    )
    db.add(row)
    return row


def add_trace(db: Session, transaction_id: str, trace: object) -> None:
    """Copy a coordinator attempt trace into the event table. Unknown event types are ignored."""

    if not isinstance(trace, list):
        return
    for item in trace:
        if not isinstance(item, dict):
            continue
        event_type = item.get("event")
        if not isinstance(event_type, str) or event_type not in COORDINATOR_EVENT_TYPES:
            continue
        message = item.get("message") if isinstance(item.get("message"), str) else ""
        worker_id = item.get("worker_id") if isinstance(item.get("worker_id"), str) else None
        attempt = item.get("attempt") if isinstance(item.get("attempt"), int) else None
        lamport = item.get("lamport_time") if isinstance(item.get("lamport_time"), int) else None
        add_event(
            db,
            transaction_id,
            event_type,
            message,
            service="coordinator",
            worker_id=worker_id or None,
            attempt=attempt,
            lamport_time=lamport,
        )


def list_events(db: Session, transaction_id: str) -> list[PaymentEvent]:
    return list(
        db.scalars(
            select(PaymentEvent)
            .where(PaymentEvent.transaction_id == transaction_id)
            .order_by(PaymentEvent.created_at.asc(), PaymentEvent.id.asc())
        ).all()
    )


def _safe_details(details: dict | None) -> dict | None:
    if not isinstance(details, dict) or not details:
        return None
    safe: dict[str, str | int | float | bool] = {}
    for key, value in list(details.items())[:8]:
        if not isinstance(key, str) or not key:
            continue
        if isinstance(value, (str, int, float, bool)) and not isinstance(value, bool):
            safe[key[:40]] = value if not isinstance(value, str) else value[:120]
        elif isinstance(value, bool):
            safe[key[:40]] = value
    return safe or None
