"""Idempotency keys and normalized request fingerprints."""

import hashlib
import re
import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from paysafe.db import utcnow
from paysafe.models import PENDING, Payment
from paysafe.validation import InputError

_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


class IdempotencyConflict(Exception):
    """The same key was reused for a different normalized payment."""


class PaymentStoreError(Exception):
    """A payment row could not be stored. The message is safe to show to a client."""


@dataclass(frozen=True)
class PaymentClaim:
    payment: Payment
    created: bool


def parse_idempotency_key(value: str | None) -> str | None:
    """Accept a missing key. Reject an empty or malformed one.

    A present key must be 8 to 128 characters and contain only letters, digits,
    underscores, and hyphens. Surrounding whitespace is removed first.
    """

    if value is None:
        return None
    key = value.strip()
    if not key:
        raise InputError("Idempotency-Key must not be empty.")
    if not _KEY_PATTERN.fullmatch(key):
        raise InputError(
            "Idempotency-Key must be 8 to 128 characters and use only letters, numbers, underscores, and hyphens."
        )
    return key


def request_fingerprint(amount: Decimal, description: str) -> str:
    canonical = f"{amount.quantize(Decimal('0.01'))}|{description}"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def claim_payment(db: Session, amount: Decimal, description: str, idempotency_key: str | None) -> PaymentClaim:
    """Insert a payment, or return the existing row for this idempotency key.

    `created` is true only for the request that inserted the row. Callers must
    dispatch work only in that case.
    """

    fingerprint = request_fingerprint(amount, description)
    if idempotency_key is not None:
        existing = _payment_for_key(db, idempotency_key)
        if existing is not None:
            _require_same_payload(existing, fingerprint)
            return PaymentClaim(existing, False)

    last_error: Exception | None = None
    for _ in range(3):
        now = utcnow()
        payment = Payment(
            transaction_id=_new_transaction_id(),
            amount=amount,
            description=description,
            status=PENDING,
            worker_id=None,
            idempotency_key=idempotency_key,
            request_fingerprint=fingerprint if idempotency_key is not None else None,
            reconciliation_required=False,
            created_at=now,
            updated_at=now,
        )
        db.add(payment)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            last_error = exc
            if idempotency_key is not None and _is_idempotency_conflict(exc):
                winner = _payment_for_key(db, idempotency_key)
                if winner is None:
                    raise PaymentStoreError("Could not store the payment for this idempotency key.") from exc
                _require_same_payload(winner, fingerprint)
                return PaymentClaim(winner, False)
            continue
        db.refresh(payment)
        return PaymentClaim(payment, True)
    raise PaymentStoreError("Could not allocate a transaction id.") from last_error


def _payment_for_key(db: Session, idempotency_key: str) -> Payment | None:
    return db.scalar(select(Payment).where(Payment.idempotency_key == idempotency_key))


def _require_same_payload(payment: Payment, fingerprint: str) -> None:
    if payment.request_fingerprint != fingerprint:
        raise IdempotencyConflict


def _is_idempotency_conflict(exc: IntegrityError) -> bool:
    message = str(getattr(exc, "orig", exc)).lower()
    return "idempotency_key" in message


def _new_transaction_id() -> str:
    return "TXN-" + uuid.uuid4().hex[:12].upper()
