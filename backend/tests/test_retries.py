"""Bounded retries, uncertain outcomes, and one simulated effect per transaction."""

from concurrent import futures
from datetime import datetime, timedelta, timezone
import threading

import grpc
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from coordinator.dispatcher import (
    AllWorkersUnreachable,
    ProcessOutcome,
    WorkerCallError,
    WorkerRouter,
    WorkerTarget,
    grpc_process,
)
from generated import payment_pb2_grpc
from paysafe.faults import upsert_fault
from paysafe.models import FAILED, PROCESSING, SUCCESS, UNKNOWN, Base, WorkerEffect
from paysafe.recovery import apply_worker_results, mark_unknown_outcomes
from worker.servicer import PaymentWorkerServicer


def test_retryable_deadline_then_success_uses_the_same_transaction():
    calls: list[str] = []

    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        calls.append(transaction_id)
        if len(calls) == 1:
            raise WorkerCallError(f"{worker_id}: DEADLINE_EXCEEDED")
        return ProcessOutcome(transaction_id, "SUCCESS", worker_id, "ok")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a")],
        process_caller=process_caller,
        max_attempts=2,
        retry_delay_seconds=0,
    )
    outcome = router.process("TXN-RETRY", "1.00", "retry")
    assert outcome.status == "SUCCESS"
    assert outcome.attempt_count == 2
    assert calls == ["TXN-RETRY", "TXN-RETRY"]


def test_retries_stop_at_the_configured_maximum():
    calls: list[str] = []

    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        calls.append(worker_id)
        raise WorkerCallError(f"{worker_id}: DEADLINE_EXCEEDED")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a")],
        process_caller=process_caller,
        max_attempts=2,
        retry_delay_seconds=0,
    )
    outcome = router.process("TXN-CAP", "1.00", "cap")
    assert outcome.status == "UNKNOWN"
    assert outcome.attempt_count == 2
    assert calls == ["worker-a", "worker-a"]


def test_unreachable_workers_stop_after_the_maximum_and_are_not_unknown():
    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        raise WorkerCallError(f"{worker_id}: UNAVAILABLE")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a")],
        process_caller=process_caller,
        max_attempts=2,
        retry_delay_seconds=0,
    )
    with pytest.raises(AllWorkersUnreachable) as caught:
        router.process("TXN-DOWN", "1.00", "down")
    assert caught.value.attempt_count == 2


def test_definitive_worker_failure_is_not_retried():
    calls: list[str] = []

    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        calls.append(worker_id)
        return ProcessOutcome(transaction_id, "FAILED", worker_id, "Simulated processing failure.")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a"), WorkerTarget("worker-b", "b")],
        process_caller=process_caller,
        max_attempts=3,
    )
    outcome = router.process("TXN-FAIL", "1.00", "fail")
    assert outcome.status == "FAILED"
    assert outcome.attempt_count == 1
    assert calls == ["worker-a"]


def test_timeout_outcome_is_unknown_rather_than_failed(client, monkeypatch):
    def unknown(transaction_id: str, amount: str, description: str) -> dict:
        return {
            "transaction_id": transaction_id,
            "status": "UNKNOWN",
            "worker_id": "worker-a",
            "message": "The worker did not answer before the deadline.",
            "attempt_count": 2,
            "last_error": "worker-a: DEADLINE_EXCEEDED",
        }

    monkeypatch.setattr("api.main.coordinator_client.process", unknown)
    response = client.post("/api/payments", json={"amount": "4.00", "description": "deadline"})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "UNKNOWN"
    assert body["status"] != "FAILED"
    assert body["attempt_count"] == 2
    assert body["reconciliation_required"] is True
    assert "deadline" in body["last_error"]


def test_definitive_failure_is_stored_as_failed(client, monkeypatch):
    def failed(transaction_id: str, amount: str, description: str) -> dict:
        return {
            "transaction_id": transaction_id,
            "status": "FAILED",
            "worker_id": "worker-b",
            "message": "Simulated processing failure.",
            "attempt_count": 1,
        }

    monkeypatch.setattr("api.main.coordinator_client.process", failed)
    response = client.post("/api/payments", json={"amount": "4.00", "description": "declined"})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "FAILED"
    assert body["worker_id"] == "worker-b"
    assert body["attempt_count"] == 1
    assert body["reconciliation_required"] is False


def test_worker_effect_runs_once_for_a_repeated_transaction(tmp_path):
    engine = create_engine(
        f"sqlite:///{(tmp_path / 'effects.db').as_posix()}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    calls: list[str] = []
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    payment_pb2_grpc.add_PaymentWorkerServicer_to_server(
        PaymentWorkerServicer("worker-a", 0, session_factory=factory, on_effect=lambda: calls.append("effect")),
        server,
    )
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        first = grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-ONCE", "2.00", "once", 2)
        second = grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-ONCE", "2.00", "once", 2)
    finally:
        server.stop(0)
    assert first.status == "SUCCESS"
    assert second.status == "SUCCESS"
    assert calls == ["effect"]


def test_concurrent_calls_apply_the_effect_once(tmp_path):
    engine = create_engine(
        f"sqlite:///{(tmp_path / 'effects.db').as_posix()}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    calls: list[str] = []
    lock = threading.Lock()

    def effect() -> None:
        with lock:
            calls.append("effect")

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8))
    payment_pb2_grpc.add_PaymentWorkerServicer_to_server(
        PaymentWorkerServicer("worker-a", 0, session_factory=factory, on_effect=effect),
        server,
    )
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    results: list[str] = []

    def call() -> None:
        outcome = grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-RACE", "2.00", "race", 2)
        results.append(outcome.status)

    try:
        threads = [threading.Thread(target=call) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        replay = grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-RACE", "2.00", "race", 2)
    finally:
        server.stop(0)
    assert calls == ["effect"]
    assert replay.status == "SUCCESS"
    assert set(results) <= {"SUCCESS", "PROCESSING"}


def test_fail_mode_records_one_definitive_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("FAULT_INJECTION_ENABLED", "true")
    engine = create_engine(
        f"sqlite:///{(tmp_path / 'effects.db').as_posix()}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    with factory() as session:
        upsert_fault(session, "worker-a", "fail", 0)
    calls: list[str] = []
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    payment_pb2_grpc.add_PaymentWorkerServicer_to_server(
        PaymentWorkerServicer("worker-a", 0, session_factory=factory, on_effect=lambda: calls.append("effect")),
        server,
    )
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        first = grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-NO", "2.00", "no", 2)
        second = grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-NO", "2.00", "no", 2)
    finally:
        server.stop(0)
    assert first.status == "FAILED"
    assert second.status == "FAILED"
    assert calls == []


def test_recovery_uses_a_worker_result_without_another_dispatch(client, monkeypatch):
    from api.coordinator_client import CoordinatorTimeout
    import paysafe.db as database
    from paysafe.db import utcnow

    def timeout(transaction_id: str, amount: str, description: str) -> dict:
        raise CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")

    monkeypatch.setattr("api.main.coordinator_client.process", timeout)
    created = client.post("/api/payments", json={"amount": "3.00", "description": "lost"})
    payment = created.json()["detail"]["payment"]
    assert payment["status"] == "PROCESSING"

    assert database.SessionLocal is not None
    now = utcnow()
    with database.SessionLocal() as session:
        session.add(
            WorkerEffect(
                transaction_id=payment["transaction_id"],
                status=SUCCESS,
                worker_id="worker-b",
                message="Simulated payment processed.",
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()
        resolved = apply_worker_results(session)
        assert [row.transaction_id for row in resolved] == [payment["transaction_id"]]
        assert resolved[0].status == "SUCCESS"
        assert resolved[0].worker_id == "worker-b"

    again = client.post("/api/admin/reconcile")
    assert again.status_code == 200
    assert again.json()["resolved"] == []
    stored = client.get(f"/api/payments/{payment['transaction_id']}").json()
    assert stored["status"] == "SUCCESS"


def test_stale_processing_without_a_worker_result_becomes_unknown(client, monkeypatch):
    from api.coordinator_client import CoordinatorTimeout
    import paysafe.db as database
    from paysafe.models import Payment

    def timeout(transaction_id: str, amount: str, description: str) -> dict:
        raise CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")

    monkeypatch.setattr("api.main.coordinator_client.process", timeout)
    created = client.post("/api/payments", json={"amount": "3.50", "description": "unsure"})
    transaction_id = created.json()["detail"]["payment"]["transaction_id"]

    assert database.SessionLocal is not None
    with database.SessionLocal() as session:
        payment = session.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
        assert payment is not None
        payment.updated_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        payment.reconciliation_required = True
        session.commit()
        changed = mark_unknown_outcomes(session)
        assert [row.transaction_id for row in changed] == [transaction_id]
        assert changed[0].status == UNKNOWN
        assert changed[0].status != FAILED
        second = mark_unknown_outcomes(session)
        assert second == []

    listed = client.get(f"/api/payments/{transaction_id}").json()
    assert listed["status"] == "UNKNOWN"
    assert listed["status"] != "FAILED"


def test_fault_switch_is_rejected_when_demo_mode_is_off(client):
    response = client.post("/api/admin/faults", json={"worker_id": "worker-a", "mode": "fail"})
    assert response.status_code == 403
    assert "disabled" in response.json()["detail"]


def test_fault_switch_rejects_an_unknown_mode(client, monkeypatch):
    monkeypatch.setenv("FAULT_INJECTION_ENABLED", "true")
    response = client.post("/api/admin/faults", json={"worker_id": "worker-a", "mode": "explode"})
    assert response.status_code == 422
    stored = client.get("/api/admin/faults")
    assert stored.status_code == 200
    assert stored.json()["faults"] == []


def test_processing_payment_is_still_identified_by_stale_recovery(client, monkeypatch):
    from api.coordinator_client import CoordinatorTimeout
    from paysafe.recovery import mark_stale_payments
    import paysafe.db as database

    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: (_ for _ in ()).throw(
            CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")
        ),
    )
    created = client.post("/api/payments", json={"amount": "1.25", "description": "stale"})
    transaction_id = created.json()["detail"]["payment"]["transaction_id"]
    with database.SessionLocal() as session:
        from paysafe.models import Payment

        payment = session.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
        assert payment is not None
        assert payment.status == PROCESSING
        payment.updated_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        session.commit()
        marked = mark_stale_payments(session, now=datetime.now(timezone.utc), stale_after=timedelta(seconds=30))
        assert [row.transaction_id for row in marked] == [transaction_id]
        assert marked[0].status == PROCESSING
