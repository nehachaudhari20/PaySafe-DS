"""Coordinator HTTP service. Routes each payment to a worker over gRPC."""

from collections.abc import Iterator
from contextlib import asynccontextmanager
import logging

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from coordinator.dispatcher import AllWorkersUnreachable, AttemptTrace, WorkerRouter, parse_workers
from coordinator.election import election_manager
from paysafe.config import get_settings
from paysafe.db import get_db
from paysafe.election_events import record_election_event
from paysafe.leadership import read_leadership
import paysafe.db as database

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
    lamport_time: int = 0


class ProcessOut(BaseModel):
    transaction_id: str
    status: str
    worker_id: str
    message: str
    attempt_count: int = 0
    last_error: str = ""
    lamport_time: int = 0
    trace: list[TraceOut] = []


class ElectionIn(BaseModel):
    from_id: int = Field(ge=1)


class CoordinatorIn(BaseModel):
    leader_id: int = Field(ge=1)
    term: int = Field(ge=1)


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
    settings = get_settings()
    if settings.coordinator_id > 0 and database.SessionLocal is None:
        database.configure_engine(settings.database_url)
    router = get_router()
    logger.info(
        "Coordinator %s ready with workers: %s",
        settings.coordinator_id or "standalone",
        ", ".join(target.worker_id for target in router.targets),
    )
    election_manager.start()
    yield
    election_manager.stop()


app = FastAPI(title="PaySafe Coordinator", version="0.1.0", lifespan=lifespan, redirect_slashes=False)


@app.get("/health")
def health() -> dict[str, object]:
    settings = get_settings()
    return {
        "status": "ok",
        "service": "coordinator",
        "coordinator_id": settings.coordinator_id,
        "is_leader": election_manager.can_dispatch(),
        "term": election_manager.current_term,
    }


@app.get("/leadership")
def leadership(db: Session = Depends(get_db)) -> dict[str, object]:
    state = read_leadership(db)
    settings = get_settings()
    if state is None:
        return {"leader_id": None, "term": None, "coordinator_id": settings.coordinator_id, "is_leader": False}
    return {
        "leader_id": state.leader_id,
        "term": state.term,
        "lease_expires_at": state.lease_expires_at.isoformat(),
        "coordinator_id": settings.coordinator_id,
        "is_leader": election_manager.can_dispatch(),
    }


@app.get("/workers/health")
def workers_health() -> dict[str, list]:
    _require_leader()
    return {"workers": get_router().health()}


@app.post("/process", response_model=ProcessOut)
def process_payment(body: ProcessIn) -> ProcessOut:
    _require_leader()
    router = get_router()
    try:
        outcome = router.process(body.transaction_id, body.amount, body.description)
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
        lamport_time=router.lamport_time,
        trace=[TraceOut(**item) for item in _trace_payload(outcome.trace)],
    )


@app.post("/internal/bully/election")
def bully_election(body: ElectionIn) -> dict[str, str]:
    election_manager.handle_election(body.from_id)
    return {"status": "ok"}


@app.post("/internal/bully/coordinator")
def bully_coordinator(body: CoordinatorIn) -> dict[str, str]:
    election_manager.handle_coordinator_announcement(body.leader_id, body.term)
    return {"status": "ok"}


def _require_leader() -> None:
    settings = get_settings()
    if settings.coordinator_id <= 0:
        return
    if election_manager.can_dispatch():
        return
    state = None
    if database.SessionLocal is not None:
        with database.SessionLocal() as session:
            state = read_leadership(session)
            record_election_event(
                session,
                coordinator_id=settings.coordinator_id,
                event_type="FENCING_REJECTED",
                message="Authoritative dispatch rejected because this coordinator is not the fenced leader.",
                term=election_manager.current_term,
            )
    raise HTTPException(
        status_code=403,
        detail={
            "message": "This coordinator is not the current leader.",
            "leader_id": state.leader_id if state else None,
            "term": state.term if state else None,
            "not_leader": True,
        },
    )


def _trace_payload(trace: list[AttemptTrace] | tuple[AttemptTrace, ...]) -> list[dict[str, object]]:
    return [
        {
            "attempt": item.attempt,
            "worker_id": item.worker_id,
            "event": item.event,
            "message": item.message,
            "lamport_time": item.lamport_time,
        }
        for item in trace
    ]
