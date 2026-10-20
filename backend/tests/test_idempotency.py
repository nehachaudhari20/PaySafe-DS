"""Idempotent payment creation."""

from decimal import Decimal
import threading

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from api.coordinator_client import CoordinatorTimeout
from paysafe.db import utcnow
from paysafe.idempotency import parse_idempotency_key, request_fingerprint
from paysafe.models import Payment
from paysafe.validation import InputError

KEY = "retry-key-01"


def _success(calls: list[str]):
    def process(transaction_id: str, amount: str, description: str) -> dict:
        calls.append(transaction_id)
        return {
            "transaction_id": transaction_id,
            "status": "SUCCESS",
            "worker_id": "worker-a",
            "message": "Simulated payment processed.",
        }

    return process


def test_fingerprint_uses_normalized_amount_and_description():
    assert request_fingerprint(Decimal("12.50"), "Lab fee") == request_fingerprint(Decimal("12.5"), "Lab fee")
    assert request_fingerprint(Decimal("12.50"), "Lab fee") != request_fingerprint(Decimal("12.50"), "Other fee")


def test_parse_idempotency_key_accepts_a_normal_key():
    assert parse_idempotency_key(None) is None
    assert parse_idempotency_key("  retry-key-01  ") == "retry-key-01"
    assert parse_idempotency_key("a" * 128) == "a" * 128


@pytest.mark.parametrize("value", ["", "   ", "short", "a" * 129, "bad key", "pay/key-01"])
def test_parse_idempotency_key_rejects_malformed_values(value):
    with pytest.raises(InputError):
        parse_idempotency_key(value)


def test_new_key_creates_one_payment(client, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr("api.main.coordinator_client.process", _success(calls))

    response = client.post(
        "/api/payments",
        json={"amount": "12.50", "description": "Lab fee"},
        headers={"Idempotency-Key": KEY},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "SUCCESS"
    assert body["idempotency_key"] == KEY
    assert body["reconciliation_required"] is False
    assert len(calls) == 1
    assert len(client.get("/api/payments").json()) == 1


def test_repeating_a_completed_request_does_not_create_or_dispatch_again(client, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr("api.main.coordinator_client.process", _success(calls))
    payload = {"amount": "12.50", "description": "Lab fee"}
    headers = {"Idempotency-Key": KEY}

    first = client.post("/api/payments", json=payload, headers=headers)
    second = client.post("/api/payments", json={"amount": "12.5", "description": "Lab fee"}, headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["transaction_id"] == first.json()["transaction_id"]
    assert second.json()["status"] == "SUCCESS"
    assert second.json()["worker_id"] == "worker-a"
    assert len(calls) == 1
    assert len(client.get("/api/payments").json()) == 1


def test_repeating_an_in_progress_request_does_not_dispatch_again(client, monkeypatch):
    calls: list[str] = []

    def timeout(transaction_id: str, amount: str, description: str) -> dict:
        calls.append(transaction_id)
        raise CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")

    monkeypatch.setattr("api.main.coordinator_client.process", timeout)
    payload = {"amount": "8.00", "description": "Slow"}
    headers = {"Idempotency-Key": "still-processing"}

    first = client.post("/api/payments", json=payload, headers=headers)
    second = client.post("/api/payments", json=payload, headers=headers)

    assert first.status_code == 504
    assert first.json()["detail"]["payment"]["status"] == "PROCESSING"
    assert second.status_code == 200
    assert second.json()["transaction_id"] == first.json()["detail"]["payment"]["transaction_id"]
    assert second.json()["status"] == "PROCESSING"
    assert second.json()["reconciliation_required"] is False
    assert len(calls) == 1


@pytest.mark.parametrize(
    "second_payload",
    [
        {"amount": "99.00", "description": "Lab fee"},
        {"amount": "12.50", "description": "Different fee"},
    ],
)
def test_reusing_a_key_with_a_different_payload_returns_409(client, monkeypatch, second_payload):
    calls: list[str] = []
    monkeypatch.setattr("api.main.coordinator_client.process", _success(calls))
    headers = {"Idempotency-Key": KEY}
    original = client.post(
        "/api/payments",
        json={"amount": "12.50", "description": "Lab fee"},
        headers=headers,
    )

    conflict = client.post("/api/payments", json=second_payload, headers=headers)

    assert original.status_code == 200
    assert conflict.status_code == 409
    assert "different amount or description" in conflict.json()["detail"]
    assert len(calls) == 1
    assert len(client.get("/api/payments").json()) == 1


def test_requests_without_a_key_still_create_separate_payments(client, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr("api.main.coordinator_client.process", _success(calls))
    payload = {"amount": "3.00", "description": "No key"}

    first = client.post("/api/payments", json=payload)
    second = client.post("/api/payments", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["transaction_id"] != second.json()["transaction_id"]
    assert first.json()["idempotency_key"] is None
    assert len(calls) == 2
    assert len(client.get("/api/payments").json()) == 2


@pytest.mark.parametrize("key", ["", "   ", "short", "a" * 129, "bad key"])
def test_invalid_idempotency_keys_are_rejected(client, monkeypatch, key):
    def explode(transaction_id: str, amount: str, description: str) -> dict:
        raise AssertionError("coordinator should not be called")

    monkeypatch.setattr("api.main.coordinator_client.process", explode)
    response = client.post(
        "/api/payments",
        json={"amount": "4.00", "description": "Invalid key"},
        headers={"Idempotency-Key": key},
    )
    assert response.status_code == 422
    assert "Idempotency-Key" in response.json()["detail"]
    assert client.get("/api/payments").json() == []


def test_database_constraint_rejects_duplicate_idempotency_keys(client):
    import paysafe.db as database

    now = utcnow()

    def make(transaction_id: str, key: str | None) -> Payment:
        return Payment(
            transaction_id=transaction_id,
            amount=Decimal("1.00"),
            description="constraint",
            status="PENDING",
            worker_id=None,
            idempotency_key=key,
            request_fingerprint="fingerprint",
            reconciliation_required=False,
            created_at=now,
            updated_at=now,
        )

    assert database.SessionLocal is not None
    with database.SessionLocal() as session:
        session.add(make("TXN-ONE", None))
        session.add(make("TXN-TWO", None))
        session.commit()
        session.add(make("TXN-THREE", "same-key-01"))
        session.commit()
        session.add(make("TXN-FOUR", "same-key-01"))
        with pytest.raises(IntegrityError):
            session.commit()


def test_concurrent_requests_with_the_same_key_create_one_row(tmp_path):
    import paysafe.db as database
    from paysafe.idempotency import claim_payment

    database_path = (tmp_path / "concurrent.db").resolve().as_posix()
    database.configure_engine(f"sqlite:///{database_path}")
    assert database.engine is not None
    assert database.SessionLocal is not None
    Payment.metadata.create_all(bind=database.engine)
    barrier = threading.Barrier(8)
    transaction_ids: list[str] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def submit() -> None:
        barrier.wait()
        session = database.SessionLocal()
        try:
            claim = claim_payment(session, Decimal("5.00"), "Same payment", "concurrent-key")
            with lock:
                transaction_ids.append(claim.payment.transaction_id)
        except Exception as exc:
            with lock:
                errors.append(exc)
        finally:
            session.close()

    threads = [threading.Thread(target=submit) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len(transaction_ids) == 8
    assert len(set(transaction_ids)) == 1
    with database.SessionLocal() as session:
        count = session.scalar(select(func.count()).select_from(Payment))
    assert count == 1
    database.engine.dispose()
