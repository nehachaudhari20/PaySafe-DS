"""Payment API. Validates a request, stores it, and asks the coordinator to process it."""

import logging
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
from collections.abc import Iterator
from contextlib import asynccontextmanager
from typing import NoReturn

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import paysafe.db as database
from api.coordinator_client import (
    CoordinatorClient,
    CoordinatorRejected,
    CoordinatorTimeout,
    CoordinatorUnavailable,
    CoordinatorUncertain,
    WorkersUnavailable,
)
from paysafe.config import get_settings
from paysafe.db import get_db, utcnow
from paysafe.models import FAILED, PROCESSING, PENDING, SUCCESS, Payment
from paysafe.schemas import PaymentCreate, PaymentRead

logger = logging.getLogger("paysafe.api")
settings = get_settings()
coordinator_client = CoordinatorClient(
    base_url=settings.coordinator_url,
    timeout_seconds=settings.coordinator_timeout_seconds,
)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> Iterator[None]:
    if database.SessionLocal is None:
        database.configure_engine(get_settings().database_url)
        if database.engine is None:
            raise RuntimeError("Database is not configured.")
        from sqlalchemy import text

        with database.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
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


def new_transaction_id() -> str:
    return "TXN-" + uuid.uuid4().hex[:12].upper()


def dump_payment(payment: Payment) -> dict:
    return PaymentRead.model_validate(payment).model_dump(mode="json")


def abort(status_code: int, message: str, payment: Payment) -> NoReturn:
    raise HTTPException(status_code=status_code, detail={"message": message, "payment": dump_payment(payment)})


def save_status(db: Session, payment: Payment, status: str, worker_id: str | None) -> Payment:
    payment.status = status
    payment.worker_id = worker_id
    payment.updated_at = utcnow()
    db.commit()
    db.refresh(payment)
    return payment


def insert_payment(db: Session, body: PaymentCreate) -> Payment:
    last_error: Exception | None = None
    for _ in range(3):
        now = utcnow()
        payment = Payment(
            transaction_id=new_transaction_id(),
            amount=body.amount,
            description=body.description,
            status=PENDING,
            worker_id=None,
            created_at=now,
            updated_at=now,
        )
        db.add(payment)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            last_error = exc
            continue
        db.refresh(payment)
        return payment
    raise HTTPException(status_code=500, detail="Could not allocate a transaction id.") from last_error


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "payment-api"}


@app.get("/api/payments", response_model=list[PaymentRead])
def list_payments(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)) -> list[PaymentRead]:
    rows = db.scalars(select(Payment).order_by(Payment.created_at.desc(), Payment.id.desc()).limit(limit)).all()
    return [PaymentRead.model_validate(row) for row in rows]


@app.get("/api/payments/{transaction_id}", response_model=PaymentRead)
def get_payment(transaction_id: str, db: Session = Depends(get_db)) -> PaymentRead:
    payment = db.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
    if payment is None:
        raise HTTPException(status_code=404, detail="Payment not found.")
    return PaymentRead.model_validate(payment)


@app.post("/api/payments", response_model=PaymentRead)
def create_payment(body: PaymentCreate, db: Session = Depends(get_db)) -> PaymentRead:
    payment = insert_payment(db, body)
    save_status(db, payment, PROCESSING, None)
    try:
        outcome = coordinator_client.process(
            transaction_id=payment.transaction_id,
            amount=f"{payment.amount:.2f}",
            description=payment.description,
        )
    except WorkersUnavailable as exc:
        save_status(db, payment, FAILED, None)
        abort(503, str(exc), payment)
    except CoordinatorRejected as exc:
        save_status(db, payment, FAILED, None)
        abort(502, str(exc), payment)
    except CoordinatorUnavailable as exc:
        save_status(db, payment, FAILED, None)
        abort(503, str(exc), payment)
    except CoordinatorTimeout as exc:
        db.refresh(payment)
        abort(504, str(exc), payment)
    except CoordinatorUncertain as exc:
        db.refresh(payment)
        abort(502, str(exc), payment)
    except Exception:
        logger.exception("Payment %s could not be forwarded", payment.transaction_id)
        raise

    status = str(outcome.get("status", ""))
    worker_id = outcome.get("worker_id")
    worker_value = worker_id if isinstance(worker_id, str) and worker_id else None
    if status == SUCCESS and worker_value:
        save_status(db, payment, SUCCESS, worker_value)
    elif status == FAILED:
        save_status(db, payment, FAILED, worker_value)
    else:
        db.refresh(payment)
        abort(502, "Coordinator returned an unrecognized payment status.", payment)
    logger.info("Stored %s as %s via %s", payment.transaction_id, payment.status, payment.worker_id)
    return PaymentRead.model_validate(payment)


@app.get("/api/workers/health")
def workers_health() -> dict:
    try:
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
    }
