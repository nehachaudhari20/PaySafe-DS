"""Mark stale in-progress payments for reconciliation without re-executing them."""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from paysafe.models import PROCESSING, Payment


def mark_stale_payments(db: Session, *, now: datetime, stale_after: timedelta) -> list[Payment]:
    """Flag PROCESSING rows older than `stale_after`.

    The payment status stays PROCESSING. Completed rows are not selected.
    A later run does not change rows that are already flagged.
    """

    if stale_after.total_seconds() < 0:
        raise ValueError("stale_after must not be negative.")
    cutoff = now - stale_after
    rows = list(
        db.scalars(
            select(Payment).where(
                Payment.status == PROCESSING,
                Payment.reconciliation_required.is_(False),
                Payment.updated_at < cutoff,
            )
        ).all()
    )
    for payment in rows:
        payment.reconciliation_required = True
        payment.updated_at = now
    if rows:
        db.commit()
        for payment in rows:
            db.refresh(payment)
    return rows
