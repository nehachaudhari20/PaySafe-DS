"""Execution history, metrics, and retry traces."""

from datetime import datetime, timedelta, timezone

from coordinator.dispatcher import ProcessOutcome, WorkerCallError, WorkerRouter, WorkerTarget


def _success_trace(attempt: int = 1) -> list[dict]:
    return [
        {"attempt": attempt, "worker_id": "worker-a", "event": "WORKER_SELECTED", "message": "Selected worker-a."},
        {"attempt": attempt, "worker_id": "worker-a", "event": "ATTEMPT_STARTED", "message": f"Attempt {attempt} called worker-a."},
        {"attempt": attempt, "worker_id": "worker-a", "event": "WORKER_RESULT_RECEIVED", "message": "Simulated payment processed."},
    ]


def _outcome(status: str, trace: list[dict], attempt_count: int = 1, message: str = "Simulated payment processed.") -> dict:
    return {
        "transaction_id": "ignored",
        "status": status,
        "worker_id": "worker-a",
        "message": message,
        "attempt_count": attempt_count,
        "last_error": "",
        "trace": trace,
    }


def _events(client, transaction_id: str) -> list[dict]:
    response = client.get(f"/api/payments/{transaction_id}/events")
    assert response.status_code == 200
    return response.json()


def test_successful_payment_records_an_execution_history(client, monkeypatch):
    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: _outcome("SUCCESS", _success_trace()),
    )
    created = client.post("/api/payments", json={"amount": "11.00", "description": "history"})
    assert created.status_code == 200
    transaction_id = created.json()["transaction_id"]
    events = _events(client, transaction_id)
    types = [event["event_type"] for event in events]
    assert types[0] == "PAYMENT_RECEIVED"
    assert "ATTEMPT_STARTED" in types
    assert "WORKER_RESULT_RECEIVED" in types
    assert types[-1] == "PAYMENT_SUCCEEDED"
    assert events[-1]["worker_id"] == "worker-a"
    assert events[-1]["attempt"] == 1
    ordered = sorted(events, key=lambda event: (event["created_at"], event["id"]))
    assert events == ordered


def test_retry_records_a_distinct_attempt(client, monkeypatch):
    trace = _success_trace(1)[:2]
    trace.append({"attempt": 2, "worker_id": "", "event": "ATTEMPT_RETRIED", "message": "Retrying because the deadline was exceeded."})
    trace.extend(_success_trace(2))
    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: _outcome("SUCCESS", trace, attempt_count=2),
    )
    created = client.post("/api/payments", json={"amount": "12.00", "description": "retry"})
    events = _events(client, created.json()["transaction_id"])
    retries = [event for event in events if event["event_type"] == "ATTEMPT_RETRIED"]
    started = [event["attempt"] for event in events if event["event_type"] == "ATTEMPT_STARTED"]
    assert len(retries) == 1
    assert retries[0]["attempt"] == 2
    assert started == [1, 2]


def test_explicit_failure_does_not_record_a_retry(client, monkeypatch):
    trace = [
        {"attempt": 1, "worker_id": "worker-b", "event": "ATTEMPT_STARTED", "message": "Attempt 1 called worker-b."},
        {"attempt": 1, "worker_id": "worker-b", "event": "WORKER_RESULT_RECEIVED", "message": "Simulated processing failure."},
    ]
    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: _outcome("FAILED", trace, message="Simulated processing failure."),
    )
    created = client.post("/api/payments", json={"amount": "13.00", "description": "declined"})
    assert created.json()["status"] == "FAILED"
    types = [event["event_type"] for event in _events(client, created.json()["transaction_id"])]
    assert "PAYMENT_FAILED" in types
    assert "ATTEMPT_RETRIED" not in types
    assert types.count("ATTEMPT_STARTED") == 1


def test_uncertain_deadline_is_unknown_and_not_failed(client, monkeypatch):
    trace = [
        {"attempt": 1, "worker_id": "worker-a", "event": "ATTEMPT_STARTED", "message": "Attempt 1 called worker-a."},
        {"attempt": 1, "worker_id": "worker-a", "event": "WORKER_UNAVAILABLE", "message": "worker-a did not answer before the deadline."},
        {"attempt": 2, "worker_id": "", "event": "ATTEMPT_RETRIED", "message": "Retrying because the deadline was exceeded."},
    ]
    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: _outcome(
            "UNKNOWN",
            trace,
            attempt_count=2,
            message="The worker did not answer before the deadline. The payment may already have been processed.",
        ),
    )
    created = client.post("/api/payments", json={"amount": "14.00", "description": "unsure"})
    body = created.json()
    assert body["status"] == "UNKNOWN"
    types = [event["event_type"] for event in _events(client, body["transaction_id"])]
    assert "PAYMENT_MARKED_UNKNOWN" in types
    assert "PAYMENT_FAILED" not in types
    assert "PAYMENT_SUCCEEDED" not in types


def test_reconciliation_resolution_is_recorded_without_another_dispatch(client, monkeypatch):
    from api.coordinator_client import CoordinatorTimeout
    import paysafe.db as database
    from paysafe.db import utcnow
    from paysafe.models import SUCCESS, WorkerEffect
    from paysafe.recovery import apply_worker_results

    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: (_ for _ in ()).throw(
            CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")
        ),
    )
    created = client.post("/api/payments", json={"amount": "15.00", "description": "recover"})
    payment = created.json()["detail"]["payment"]
    calls: list[str] = []
    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: calls.append(transaction_id),
    )
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
        assert resolved[0].status == "SUCCESS"
    events = _events(client, payment["transaction_id"])
    types = [event["event_type"] for event in events]
    assert "RECONCILIATION_RESOLVED" in types
    assert "PAYMENT_FAILED" not in types
    assert calls == []
    resolved_event = next(event for event in events if event["event_type"] == "RECONCILIATION_RESOLVED")
    assert resolved_event["worker_id"] == "worker-b"
    assert resolved_event["metadata"]["status"] == "SUCCESS"


def test_inconclusive_reconciliation_does_not_claim_success_or_failure(client, monkeypatch):
    from api.coordinator_client import CoordinatorTimeout
    import paysafe.db as database
    from paysafe.models import Payment
    from paysafe.recovery import mark_unknown_outcomes
    from sqlalchemy import select

    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: (_ for _ in ()).throw(
            CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")
        ),
    )
    created = client.post("/api/payments", json={"amount": "16.00", "description": "open"})
    transaction_id = created.json()["detail"]["payment"]["transaction_id"]
    with database.SessionLocal() as session:
        payment = session.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
        assert payment is not None
        payment.reconciliation_required = True
        payment.updated_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        session.commit()
        changed = mark_unknown_outcomes(session)
        assert changed[0].status == "UNKNOWN"
    events = _events(client, transaction_id)
    types = [event["event_type"] for event in events]
    assert "RECONCILIATION_INCONCLUSIVE" in types
    assert "RECONCILIATION_RESOLVED" not in types
    assert "PAYMENT_SUCCEEDED" not in types
    assert "PAYMENT_FAILED" not in types
    inconclusive = next(event for event in events if event["event_type"] == "RECONCILIATION_INCONCLUSIVE")
    assert "not FAILED" in inconclusive["message"]


def test_missing_payment_events_return_404(client):
    response = client.get("/api/payments/TXN-MISSING/events")
    assert response.status_code == 404
    assert response.json()["detail"] == "Payment not found."


def test_metrics_exclude_unknown_and_processing_from_the_success_rate(client, monkeypatch):
    def route(transaction_id: str, amount: str, description: str) -> dict:
        if description == "ok":
            return _outcome("SUCCESS", _success_trace())
        if description == "bad":
            return _outcome("FAILED", _success_trace(), message="Simulated processing failure.")
        return _outcome("UNKNOWN", _success_trace(), message="The result is not confirmed.")

    monkeypatch.setattr("api.main.coordinator_client.process", route)
    client.post("/api/payments", json={"amount": "1.00", "description": "ok"})
    client.post("/api/payments", json={"amount": "1.00", "description": "ok"})
    client.post("/api/payments", json={"amount": "1.00", "description": "bad"})
    client.post("/api/payments", json={"amount": "1.00", "description": "unsure"})
    from api.coordinator_client import CoordinatorTimeout

    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: (_ for _ in ()).throw(CoordinatorTimeout("still processing")),
    )
    client.post("/api/payments", json={"amount": "1.00", "description": "open"})
    metrics = client.get("/api/metrics")
    assert metrics.status_code == 200
    body = metrics.json()
    assert body["total_payments"] == 5
    assert body["successful_payments"] == 2
    assert body["failed_payments"] == 1
    assert body["unknown_payments"] == 1
    assert body["processing_payments"] == 1
    assert body["success_rate"] == 2 / 3
    assert body["worker_attempts"] == 4
    assert "SUCCESS and FAILED" in body["success_rate_basis"]


def test_empty_metrics_do_not_divide_by_zero(client):
    body = client.get("/api/metrics").json()
    assert body["total_payments"] == 0
    assert body["success_rate"] is None
    assert body["retries"] == 0
    assert body["reconciliation_resolved"] == 0


def test_coordinator_retry_trace_uses_the_next_attempt_number():
    calls: list[int] = []

    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        calls.append(1)
        if len(calls) == 1:
            raise WorkerCallError(f"{worker_id}: DEADLINE_EXCEEDED")
        return ProcessOutcome(transaction_id, "SUCCESS", worker_id, "ok")

    router = WorkerRouter([WorkerTarget("worker-a", "a")], process_caller=process_caller, max_attempts=2)
    outcome = router.process("TXN-TRACE", "1.00", "trace")
    events = [(item.event, item.attempt) for item in outcome.trace]
    assert ("ATTEMPT_RETRIED", 2) in events
    assert events.count(("ATTEMPT_STARTED", 1)) == 1
    assert events.count(("ATTEMPT_STARTED", 2)) == 1
    assert outcome.status == "SUCCESS"


def test_coordinator_definitive_failure_trace_has_no_retry():
    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        return ProcessOutcome(transaction_id, "FAILED", worker_id, "Simulated processing failure.")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a"), WorkerTarget("worker-b", "b")],
        process_caller=process_caller,
        max_attempts=3,
    )
    outcome = router.process("TXN-TRACE-FAIL", "1.00", "trace")
    events = [item.event for item in outcome.trace]
    assert events.count("ATTEMPT_STARTED") == 1
    assert "ATTEMPT_RETRIED" not in events
    assert outcome.status == "FAILED"
