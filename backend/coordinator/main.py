"""Coordinator HTTP service. Routes each payment to a worker over gRPC."""

from collections.abc import Iterator
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from coordinator.dispatcher import AllWorkersUnreachable, AttemptTrace, WorkerRouter, parse_workers
from paysafe.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("paysafe.coordinator")
router_holder: dict[str, WorkerRouter | None] = {"router": None}


class ProcessIn(BaseModel):
    transaction_id: str = Field(min_length=1, max_length=64)
    amount: str = Field(min_length=1, max_length=32)
    description: str = Field(min_length=1, max_length=200)


class TraceOut(BaseModel):
    attempt: int
    worker_id: str = ""
    event: str
    message: str


class ProcessOut(BaseModel):
    transaction_id: str
    status: str
    worker_id: str
    message: str
    attempt_count: int = 0
    last_error: str = ""
    trace: list[TraceOut] = []


def get_router() -> WorkerRouter:
    if router_holder["router"] is None:
        settings = get_settings()
        router_holder["router"] = WorkerRouter(
            parse_workers(settings.workers),
            timeout_seconds=settings.grpc_timeout_seconds,
            health_timeout_seconds=settings.grpc_health_timeout_seconds,
            max_attempts=settings.worker_max_attempts,
            retry_delay_seconds=settings.worker_retry_delay_seconds,
        )
    router = router_holder["router"]
    if router is None:
        raise RuntimeError("Worker router is not configured.")
    return router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> Iterator[None]:
    router = get_router()
    logger.info("Coordinator ready with workers: %s", ", ".join(target.worker_id for target in router.targets))
    yield


app = FastAPI(title="PaySafe Coordinator", version="0.1.0", lifespan=lifespan, redirect_slashes=False)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "coordinator"}


@app.get("/workers/health")
def workers_health() -> dict[str, list]:
    return {"workers": get_router().health()}


@app.post("/process", response_model=ProcessOut)
def process_payment(body: ProcessIn) -> ProcessOut:
    try:
        outcome = get_router().process(body.transaction_id, body.amount, body.description)
    except AllWorkersUnreachable as exc:
        logger.warning("No worker reachable for %s after %s attempt(s): %s", body.transaction_id, exc.attempt_count, exc)
        raise HTTPException(
            status_code=503,
            detail={
                "message": "No payment worker was reachable.",
                "attempt_count": exc.attempt_count,
                "last_error": str(exc)[:300],
                "trace": _trace_payload(exc.trace),
            },
        ) from exc
    logger.info("Routed %s to %s on attempt %s", outcome.transaction_id, outcome.worker_id or "none", outcome.attempt_count)
    return ProcessOut(
        transaction_id=outcome.transaction_id,
        status=outcome.status,
        worker_id=outcome.worker_id,
        message=outcome.message,
        attempt_count=outcome.attempt_count,
        last_error=outcome.last_error,
        trace=[TraceOut(**item) for item in _trace_payload(outcome.trace)],
    )


def _trace_payload(trace: list[AttemptTrace] | tuple[AttemptTrace, ...]) -> list[dict[str, object]]:
    return [
        {"attempt": item.attempt, "worker_id": item.worker_id, "event": item.event, "message": item.message}
        for item in trace
    ]
