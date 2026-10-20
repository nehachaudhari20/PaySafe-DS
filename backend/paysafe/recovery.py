"""Mark stale in-progress payments for reconciliation without re-executing them."""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from paysafe.db import utcnow
from paysafe.effects import get_effect
from paysafe.events import add_event
from paysafe.models import FAILED, PROCESSING, SUCCESS, UNKNOWN, Payment, WorkerEffect


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


def apply_worker_results(db: Session) -> list[Payment]:
    """Copy a terminal worker effect onto a PROCESSING or UNKNOWN payment.

    SUCCESS and FAILED payments are not selected. This does not call a worker.
    """

    effects = {
        effect.transaction_id: effect
        for effect in db.scalars(select(WorkerEffect).where(WorkerEffect.status.in_((SUCCESS, FAILED)))).all()
    }
    if not effects:
        return []
    payments = list(
        db.scalars(
            select(Payment).where(
                Payment.status.in_((PROCESSING, UNKNOWN)),
                Payment.transaction_id.in_(effects),
            )
        ).all()
    )
    now = utcnow()
    for payment in payments:
        effect = effects[payment.transaction_id]
        payment.status = effect.status
        payment.worker_id = effect.worker_id
        payment.reconciliation_required = False
        payment.last_error = None
        payment.updated_at = now
        add_event(
            db,
            payment.transaction_id,
            "RECONCILIATION_STARTED",
            "Reconciliation checked this payment against the stored worker effect.",
            service="api",
        )
        add_event(
            db,
            payment.transaction_id,
            "RECONCILIATION_RESOLVED",
            f"Applied the stored worker result {effect.status}. The payment was not sent to a worker again.",
            service="api",
            worker_id=effect.worker_id,
            details={"status": effect.status},
        )
    if payments:
        db.commit()
        for payment in payments:
            db.refresh(payment)
    return payments


def mark_unknown_outcomes(db: Session) -> list[Payment]:
    """Turn flagged PROCESSING rows with no terminal worker result into UNKNOWN.

    UNKNOWN is not a confirmed failure. Rows that are already UNKNOWN are left unchanged.
    """

    rows = list(
        db.scalars(select(Payment).where(Payment.status == PROCESSING, Payment.reconciliation_required.is_(True))).all()
    )
    now = utcnow()
    changed: list[Payment] = []
    for payment in rows:
        effect = get_effect(db, payment.transaction_id)
        if effect is not None and effect.status in (SUCCESS, FAILED):
            continue
        payment.status = UNKNOWN
        payment.last_error = "No worker result was found. The outcome is unknown and was not marked failed."
        payment.updated_at = now
        add_event(
            db,
            payment.transaction_id,
            "RECONCILIATION_STARTED",
            "Reconciliation checked this payment for a stored worker effect.",
            service="api",
        )
        add_event(
            db,
            payment.transaction_id,
            "RECONCILIATION_INCONCLUSIVE",
            "No terminal worker result was found. The payment was marked UNKNOWN, not FAILED.",
            service="api",
        )
        changed.append(payment)
    if changed:
        db.commit()
        for payment in changed:
            db.refresh(payment)
    return changed
