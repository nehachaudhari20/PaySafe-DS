"""Payment API. Validates a request, stores it, and asks the coordinator to process it."""

from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import timedelta
import logging
from typing import Annotated, NoReturn

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

import paysafe.db as database
from api.coordinator_client import (
    CoordinatorClient,
    CoordinatorRejected,
    CoordinatorTimeout,
    CoordinatorUnavailable,
    CoordinatorUncertain,
    NotCoordinatorLeader,
    WorkersUnavailable,
)
from paysafe.leadership import leader_base_url, read_leadership
from paysafe.api_clock import api_clock
from paysafe.config import get_settings
from paysafe.db import get_db, utcnow
from paysafe.effects import get_effect
from paysafe.events import add_event, add_trace, list_events
from paysafe.faults import list_faults, upsert_fault
from paysafe.idempotency import IdempotencyConflict, PaymentStoreError, claim_payment, parse_idempotency_key
from paysafe.metrics import payment_metrics
from paysafe.models import FAILED, PROCESSING, SUCCESS, UNKNOWN, Payment, PaymentEvent
from paysafe.recovery import apply_worker_results, mark_stale_payments, mark_unknown_outcomes
from paysafe.schemas import PaymentCreate, PaymentEventRead, PaymentMetrics, PaymentRead
from paysafe.validation import InputError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

logger = logging.getLogger("paysafe.api")
settings = get_settings()
coordinator_client = CoordinatorClient(
    base_url=settings.coordinator_url,
    timeout_seconds=settings.coordinator_timeout_seconds,
)


def _coordinator_base_url(db: Session) -> str:
    current = get_settings()
    return leader_base_url(db, current.coordinator_peers, current.coordinator_url)


def _dispatch_to_coordinator(db: Session, **kwargs):
    base_url = _coordinator_base_url(db)
    try:
        return coordinator_client.process(base_url=base_url, **kwargs)
    except TypeError:
        return coordinator_client.process(**kwargs)
    except NotCoordinatorLeader:
        return coordinator_client.process(base_url=_coordinator_base_url(db), **kwargs)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> Iterator[None]:
    if database.SessionLocal is None:
        database.configure_engine(get_settings().database_url)
        if database.engine is None:
            raise RuntimeError("Database is not configured.")
        from sqlalchemy import text

        with database.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    with database.SessionLocal() as session:
        resolved = apply_worker_results(session)
    if resolved:
        logger.info("Startup recovery applied %s worker result(s).", len(resolved))
    logger.info("Payment API is ready.")
    yield


app = FastAPI(title="PaySafe Payment API", version="0.1.0", lifespan=lifespan, redirect_slashes=False)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    messages = [_format_validation_error(error) for error in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": "; ".join(messages)})


def _format_validation_error(error: dict) -> str:
    context = error.get("ctx") or {}
    original = context.get("error")
    if isinstance(original, Exception):
        message = str(original)
    else:
        message = str(error.get("msg", "Invalid value."))
        prefix = "Value error, "
        if message.startswith(prefix):
            message = message[len(prefix) :]
    return message


def dump_payment(payment: Payment) -> dict:
    return PaymentRead.model_validate(payment).model_dump(mode="json")


def abort(status_code: int, message: str, payment: Payment) -> NoReturn:
    raise HTTPException(status_code=status_code, detail={"message": message, "payment": dump_payment(payment)})


def save_status(
    db: Session,
    payment: Payment,
    status: str,
    worker_id: str | None,
    *,
    attempt_count: int | None = None,
    last_error: str | None = None,
    reconciliation_required: bool | None = None,
) -> Payment:
    payment.status = status
    payment.worker_id = worker_id
    if attempt_count is not None:
        payment.attempt_count = attempt_count
    if last_error is not None:
        payment.last_error = last_error[:300]
    if attempt_count:
        payment.last_attempt_at = utcnow()
    if reconciliation_required is not None:
        payment.reconciliation_required = reconciliation_required
    elif status in (SUCCESS, FAILED):
        payment.reconciliation_required = False
    payment.updated_at = utcnow()
    db.commit()
    db.refresh(payment)
    return payment


def adopt_recorded_effect(db: Session, payment: Payment) -> Payment | None:
    """Use a worker effect row when one exists. Returns None when the worker has no record."""

    effect = get_effect(db, payment.transaction_id)
    if effect is None:
        return None
    if effect.status == SUCCESS:
        add_event(
            db,
            payment.transaction_id,
            "PAYMENT_SUCCEEDED",
            "A stored worker effect confirmed success after the coordinator call did not finish.",
            service="api",
            worker_id=effect.worker_id,
            lamport_time=api_clock.tick(),
        )
        return save_status(db, payment, SUCCESS, effect.worker_id)
    if effect.status == FAILED:
        add_event(
            db,
            payment.transaction_id,
            "PAYMENT_FAILED",
            effect.message or "A stored worker effect confirmed a failure.",
            service="api",
            worker_id=effect.worker_id,
            lamport_time=api_clock.tick(),
        )
        return save_status(db, payment, FAILED, effect.worker_id, last_error=effect.message or "Simulated processing failure.")
    add_event(
        db,
        payment.transaction_id,
        "PAYMENT_MARKED_UNKNOWN",
        "A worker claimed this payment, but the result is not confirmed.",
        service="api",
        worker_id=effect.worker_id,
        lamport_time=api_clock.tick(),
    )
    return save_status(
        db,
        payment,
        UNKNOWN,
        effect.worker_id,
        last_error="A worker claimed this payment, but the result is not confirmed.",
        reconciliation_required=True,
    )


class FaultIn(BaseModel):
    worker_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    mode: str
    delay_seconds: float = 0


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "payment-api"}


@app.get("/api/payments", response_model=list[PaymentRead])
def list_payments(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)) -> list[PaymentRead]:
    rows = db.scalars(select(Payment).order_by(Payment.created_at.desc(), Payment.id.desc()).limit(limit)).all()
    return [PaymentRead.model_validate(row) for row in rows]


@app.get("/api/metrics", response_model=PaymentMetrics)
def metrics(db: Session = Depends(get_db)) -> PaymentMetrics:
    payload = payment_metrics(db)
    payload["fault_injection_enabled"] = get_settings().fault_injection_enabled
    return PaymentMetrics.model_validate(payload)


@app.get("/api/payments/{transaction_id}/events", response_model=list[PaymentEventRead])
def payment_events(transaction_id: str, db: Session = Depends(get_db)) -> list[PaymentEventRead]:
    payment = db.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
    if payment is None:
        raise HTTPException(status_code=404, detail="Payment not found.")
    return [_event_read(row) for row in list_events(db, transaction_id)]


@app.get("/api/payments/{transaction_id}", response_model=PaymentRead)
def get_payment(transaction_id: str, db: Session = Depends(get_db)) -> PaymentRead:
    payment = db.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
    if payment is None:
        raise HTTPException(status_code=404, detail="Payment not found.")
    return PaymentRead.model_validate(payment)


@app.post("/api/payments", response_model=PaymentRead)
def create_payment(
    body: PaymentCreate,
    db: Session = Depends(get_db),
    idempotency_key: Annotated[str | None, Header()] = None,
) -> PaymentRead:
    try:
        key = parse_idempotency_key(idempotency_key)
    except InputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        claim = claim_payment(db, body.amount, body.description, key)
    except IdempotencyConflict as exc:
        raise HTTPException(
            status_code=409,
            detail="This idempotency key was already used for a different amount or description.",
        ) from exc
    except PaymentStoreError as exc:
        logger.exception("Could not store a payment")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    payment = claim.payment
    if not claim.created:
        logger.info("Replayed %s without dispatching again", payment.transaction_id)
        return PaymentRead.model_validate(payment)

    add_event(
        db,
        payment.transaction_id,
        "PAYMENT_RECEIVED",
        "Payment accepted and stored.",
        service="api",
        lamport_time=api_clock.tick(),
    )
    save_status(db, payment, PROCESSING, None)
    try:
        outcome = _dispatch_to_coordinator(
            db,
            transaction_id=payment.transaction_id,
            amount=f"{payment.amount:.2f}",
            description=payment.description,
        )
    except WorkersUnavailable as exc:
        recorded = adopt_recorded_effect(db, payment)
        if recorded is not None:
            return PaymentRead.model_validate(recorded)
        add_trace(db, payment.transaction_id, exc.trace)
        add_event(
            db,
            payment.transaction_id,
            "PAYMENT_FAILED",
            str(exc),
            service="api",
            attempt=exc.attempt_count or None,
            lamport_time=api_clock.tick(),
        )
        save_status(db, payment, FAILED, None, attempt_count=exc.attempt_count, last_error=exc.last_error or str(exc))
        abort(503, str(exc), payment)
    except CoordinatorRejected as exc:
        add_event(db, payment.transaction_id, "PAYMENT_FAILED", str(exc), service="api", lamport_time=api_clock.tick())
        save_status(db, payment, FAILED, None, last_error=str(exc))
        abort(502, str(exc), payment)
    except CoordinatorUnavailable as exc:
        recorded = adopt_recorded_effect(db, payment)
        if recorded is not None:
            return PaymentRead.model_validate(recorded)
        add_event(db, payment.transaction_id, "PAYMENT_FAILED", str(exc), service="api", lamport_time=api_clock.tick())
        save_status(db, payment, FAILED, None, last_error=str(exc))
        abort(503, str(exc), payment)
    except CoordinatorTimeout as exc:
        recorded = adopt_recorded_effect(db, payment)
        if recorded is not None:
            return PaymentRead.model_validate(recorded)
        add_event(
            db,
            payment.transaction_id,
            "COORDINATOR_TIMEOUT",
            "The coordinator did not respond in time. Worker attempts after that point are not known, and the payment was not marked failed.",
            service="api",
            lamport_time=api_clock.tick(),
        )
        db.commit()
        db.refresh(payment)
        abort(504, str(exc), payment)
    except CoordinatorUncertain as exc:
        recorded = adopt_recorded_effect(db, payment)
        if recorded is not None:
            return PaymentRead.model_validate(recorded)
        add_event(
            db,
            payment.transaction_id,
            "COORDINATOR_TIMEOUT",
            "The coordinator response was not received. The payment was not marked failed.",
            service="api",
            lamport_time=api_clock.tick(),
        )
        db.commit()
        db.refresh(payment)
        abort(502, str(exc), payment)
    except Exception:
        logger.exception("Payment %s could not be forwarded", payment.transaction_id)
        raise

    try:
        stored = store_coordinator_outcome(db, payment, outcome)
    except ValueError as exc:
        db.refresh(payment)
        abort(502, str(exc), payment)
    logger.info("Stored %s as %s via %s", stored.transaction_id, stored.status, stored.worker_id)
    return PaymentRead.model_validate(stored)


def store_coordinator_outcome(db: Session, payment: Payment, outcome: dict) -> Payment:
    status = str(outcome.get("status", ""))
    worker_id = outcome.get("worker_id")
    worker_value = worker_id if isinstance(worker_id, str) and worker_id else None
    attempt_count = outcome.get("attempt_count")
    attempts = attempt_count if isinstance(attempt_count, int) and attempt_count >= 0 else None
    message = outcome.get("message") if isinstance(outcome.get("message"), str) else None
    last_error = outcome.get("last_error") if isinstance(outcome.get("last_error"), str) and outcome.get("last_error") else None
    coordinator_lamport = outcome.get("lamport_time")
    if isinstance(coordinator_lamport, int) and coordinator_lamport > 0:
        api_clock.receive(coordinator_lamport)
    add_trace(db, payment.transaction_id, outcome.get("trace"))
    if status == SUCCESS and worker_value:
        add_event(
            db,
            payment.transaction_id,
            "PAYMENT_SUCCEEDED",
            "Payment succeeded.",
            service="api",
            worker_id=worker_value,
            attempt=attempts,
            lamport_time=api_clock.tick(),
        )
        return save_status(db, payment, SUCCESS, worker_value, attempt_count=attempts, last_error=last_error)
    if status == FAILED:
        add_event(
            db,
            payment.transaction_id,
            "PAYMENT_FAILED",
            last_error or message or "A worker confirmed a simulated processing failure.",
            service="api",
            worker_id=worker_value,
            attempt=attempts,
            lamport_time=api_clock.tick(),
        )
        return save_status(db, payment, FAILED, worker_value, attempt_count=attempts, last_error=last_error or message)
    if status == UNKNOWN:
        add_event(
            db,
            payment.transaction_id,
            "PAYMENT_MARKED_UNKNOWN",
            message or last_error or "The outcome could not be confirmed. This is not a confirmed failure.",
            service="api",
            worker_id=worker_value,
            attempt=attempts,
            lamport_time=api_clock.tick(),
        )
        return save_status(
            db,
            payment,
            UNKNOWN,
            worker_value,
            attempt_count=attempts,
            last_error=message or last_error,
            reconciliation_required=True,
        )
    raise ValueError("Coordinator returned an unrecognized payment status.")


@app.post("/api/admin/reconcile")
def reconcile_stale_payments(db: Session = Depends(get_db)) -> dict[str, object]:
    """Apply known worker results, flag stale PROCESSING rows, then mark unverified rows UNKNOWN.

    This demo route has no authentication. It does not call a worker and does not mark a payment FAILED.
    """

    settings = get_settings()
    resolved = apply_worker_results(db)
    marked = mark_stale_payments(
        db,
        now=utcnow(),
        stale_after=timedelta(seconds=settings.processing_stale_seconds),
    )
    unknown = mark_unknown_outcomes(db)
    logger.info(
        "Reconciliation resolved %s, flagged %s, and left %s unknown",
        len(resolved),
        len(marked),
        len(unknown),
    )
    return {
        "marked": len(marked),
        "transaction_ids": [payment.transaction_id for payment in marked],
        "resolved": [payment.transaction_id for payment in resolved],
        "unknown": [payment.transaction_id for payment in unknown],
    }


@app.get("/api/admin/faults")
def get_faults(db: Session = Depends(get_db)) -> dict[str, list[dict[str, object]]]:
    """List development fault switches. This demo route has no authentication."""

    _require_fault_injection()
    return {
        "faults": [
            {"worker_id": row.worker_id, "mode": row.mode, "delay_seconds": row.delay_seconds}
            for row in list_faults(db)
        ]
    }


@app.post("/api/admin/faults")
def set_fault(body: FaultIn, db: Session = Depends(get_db)) -> dict[str, object]:
    """Set a development fault switch. Use mode `normal` to reset it. This demo route has no authentication."""

    _require_fault_injection()
    try:
        row = upsert_fault(db, body.worker_id, body.mode, body.delay_seconds)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    logger.info("Fault for %s set to %s", row.worker_id, row.mode)
    return {"worker_id": row.worker_id, "mode": row.mode, "delay_seconds": row.delay_seconds}


def _event_read(row: PaymentEvent) -> PaymentEventRead:
    details = row.details if isinstance(row.details, dict) else None
    return PaymentEventRead(
        id=row.id,
        transaction_id=row.transaction_id,
        event_type=row.event_type,
        created_at=row.created_at,
        service=row.service,
        worker_id=row.worker_id,
        attempt=row.attempt,
        lamport_time=row.lamport_time,
        message=row.message,
        metadata=details,
    )


def _require_fault_injection() -> None:
    if not get_settings().fault_injection_enabled:
        raise HTTPException(
            status_code=403,
            detail="Fault injection is disabled. Set FAULT_INJECTION_ENABLED=true only for a local demo.",
        )


@app.get("/api/coordinator/leadership")
def coordinator_leadership(db: Session = Depends(get_db)) -> dict[str, object]:
    state = read_leadership(db)
    settings = get_settings()
    if state is None:
        return {
            "leader_id": None,
            "term": None,
            "lease_expires_at": None,
            "leader_url": _coordinator_base_url(db),
            "peers_configured": bool(settings.coordinator_peers.strip()),
        }
    return {
        "leader_id": state.leader_id,
        "term": state.term,
        "lease_expires_at": state.lease_expires_at.isoformat(),
        "leader_url": _coordinator_base_url(db),
        "peers_configured": bool(settings.coordinator_peers.strip()),
    }


@app.get("/api/workers/health")
def workers_health(db: Session = Depends(get_db)) -> dict:
    base_url = _coordinator_base_url(db)
    try:
        try:
            payload = coordinator_client.worker_health(base_url=base_url)
        except TypeError:
            payload = coordinator_client.worker_health()
    except NotCoordinatorLeader:
        try:
            payload = coordinator_client.worker_health(base_url=_coordinator_base_url(db))
        except (CoordinatorUnavailable, TypeError) as exc:
            if isinstance(exc, CoordinatorUnavailable):
                return {"coordinator_reachable": False, "workers": [], "detail": str(exc)}
            payload = coordinator_client.worker_health()
    except CoordinatorUnavailable as exc:
        return {
            "coordinator_reachable": False,
            "workers": [],
            "detail": str(exc),
        }
    workers = payload.get("workers", [])
    return {
        "coordinator_reachable": True,
        "workers": workers if isinstance(workers, list) else [],
        "leader_url": base_url,
    }
