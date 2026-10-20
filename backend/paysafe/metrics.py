"""Aggregate payment counts from stored rows and execution events."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from paysafe.models import FAILED, Payment, PaymentEvent, PENDING, PROCESSING, SUCCESS, UNKNOWN


def payment_metrics(db: Session) -> dict[str, object]:
    """Count payments by status and events that were actually recorded.

    Success rate uses only SUCCESS and FAILED. PROCESSING and UNKNOWN are excluded
    because they are not confirmed outcomes. The rate is null when that denominator is zero.
    Attempt and reconciliation counts come only from payment_events, so payments created
    before event recording are not given an invented attempt history.
    """

    rows = db.execute(select(Payment.status, func.count()).group_by(Payment.status)).all()
    counts = {status: int(count) for status, count in rows}
    successful = counts.get(SUCCESS, 0)
    failed = counts.get(FAILED, 0)
    unknown = counts.get(UNKNOWN, 0)
    processing = counts.get(PROCESSING, 0)
    pending = counts.get(PENDING, 0)
    completed = successful + failed
    success_rate = (successful / completed) if completed else None
    return {
        "total_payments": successful + failed + unknown + processing + pending,
        "successful_payments": successful,
        "failed_payments": failed,
        "unknown_payments": unknown,
        "processing_payments": processing,
        "pending_payments": pending,
        "success_rate": success_rate,
        "success_rate_basis": "SUCCESS and FAILED payments. PROCESSING and UNKNOWN are excluded.",
        "worker_attempts": _event_count(db, "ATTEMPT_STARTED"),
        "retries": _event_count(db, "ATTEMPT_RETRIED"),
        "reconciliation_resolved": _event_count(db, "RECONCILIATION_RESOLVED"),
        "reconciliation_inconclusive": _event_count(db, "RECONCILIATION_INCONCLUSIVE"),
    }


def _event_count(db: Session, event_type: str) -> int:
    count = db.scalar(select(func.count()).select_from(PaymentEvent).where(PaymentEvent.event_type == event_type))
    return int(count or 0)
