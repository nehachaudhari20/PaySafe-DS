"""Conservative reconciliation of stale PROCESSING payments."""

from datetime import datetime, timedelta, timezone

from api.coordinator_client import CoordinatorTimeout, WorkersUnavailable
from paysafe.recovery import mark_stale_payments

STALE_AFTER = timedelta(seconds=30)


def _success(worker_id: str = "worker-a"):
    def process(transaction_id: str, amount: str, description: str) -> dict:
        return {
            "transaction_id": transaction_id,
            "status": "SUCCESS",
            "worker_id": worker_id,
            "message": "Simulated payment processed.",
        }

    return process


def _age(transaction_id: str, updated_at: datetime) -> None:
    import paysafe.db as database
    from paysafe.models import Payment
    from sqlalchemy import select

    assert database.SessionLocal is not None
    with database.SessionLocal() as session:
        payment = session.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
        assert payment is not None
        created_at = payment.created_at
        payment.updated_at = updated_at
        session.commit()
        session.refresh(payment)
        assert payment.created_at == created_at


def _row(transaction_id: str):
    import paysafe.db as database
    from paysafe.models import Payment
    from sqlalchemy import select

    assert database.SessionLocal is not None
    with database.SessionLocal() as session:
        payment = session.scalar(select(Payment).where(Payment.transaction_id == transaction_id))
        assert payment is not None
        session.expunge(payment)
        return payment


def test_stale_processing_payment_is_flagged_without_changing_status(client, monkeypatch):
    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: (_ for _ in ()).throw(
            CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")
        ),
    )
    created = client.post("/api/payments", json={"amount": "6.00", "description": "uncertain"})
    payment = created.json()["detail"]["payment"]
    created_at = payment["created_at"]
    _age(payment["transaction_id"], datetime.now(timezone.utc) - timedelta(minutes=5))

    import paysafe.db as database

    assert database.SessionLocal is not None
    with database.SessionLocal() as session:
        marked = mark_stale_payments(session, now=datetime.now(timezone.utc), stale_after=STALE_AFTER)

    assert [row.transaction_id for row in marked] == [payment["transaction_id"]]
    stored = _row(payment["transaction_id"])
    assert stored.status == "PROCESSING"
    assert stored.reconciliation_required is True
    assert stored.worker_id is None
    assert stored.created_at.isoformat() == created_at or stored.created_at == datetime.fromisoformat(created_at)


def test_recent_processing_payment_is_not_marked(client, monkeypatch):
    monkeypatch.setattr(
        "api.main.coordinator_client.process",
        lambda transaction_id, amount, description: (_ for _ in ()).throw(
            CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")
        ),
    )
    created = client.post("/api/payments", json={"amount": "6.00", "description": "fresh"})
    transaction_id = created.json()["detail"]["payment"]["transaction_id"]

    import paysafe.db as database

    with database.SessionLocal() as session:
        marked = mark_stale_payments(session, now=datetime.now(timezone.utc), stale_after=STALE_AFTER)

    assert marked == []
    stored = _row(transaction_id)
    assert stored.status == "PROCESSING"
    assert stored.reconciliation_required is False


def test_completed_success_and_failed_payments_are_not_changed(client, monkeypatch):
    monkeypatch.setattr("api.main.coordinator_client.process", _success("worker-b"))
    success = client.post("/api/payments", json={"amount": "7.00", "description": "done"}).json()
    _age(success["transaction_id"], datetime.now(timezone.utc) - timedelta(hours=2))

    def fail(transaction_id: str, amount: str, description: str) -> dict:
        raise WorkersUnavailable("No payment worker was reachable.")

    monkeypatch.setattr("api.main.coordinator_client.process", fail)
    failed_response = client.post("/api/payments", json={"amount": "8.00", "description": "down"})
    failed = failed_response.json()["detail"]["payment"]
    _age(failed["transaction_id"], datetime.now(timezone.utc) - timedelta(hours=2))

    import paysafe.db as database

    with database.SessionLocal() as session:
        marked = mark_stale_payments(session, now=datetime.now(timezone.utc), stale_after=STALE_AFTER)

    assert marked == []
    success_row = _row(success["transaction_id"])
    failed_row = _row(failed["transaction_id"])
    assert success_row.status == "SUCCESS"
    assert success_row.worker_id == "worker-b"
    assert success_row.reconciliation_required is False
    assert failed_row.status == "FAILED"
    assert failed_row.worker_id is None
    assert failed_row.reconciliation_required is False


def test_reconciliation_is_idempotent_and_does_not_dispatch(client, monkeypatch):
    calls: list[str] = []

    def timeout(transaction_id: str, amount: str, description: str) -> dict:
        calls.append(transaction_id)
        raise CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")

    monkeypatch.setattr("api.main.coordinator_client.process", timeout)
    created = client.post("/api/payments", json={"amount": "9.00", "description": "hold"})
    transaction_id = created.json()["detail"]["payment"]["transaction_id"]
    created_at = _row(transaction_id).created_at
    _age(transaction_id, datetime.now(timezone.utc) - timedelta(minutes=10))
    calls.clear()

    import paysafe.db as database

    now = datetime.now(timezone.utc)
    with database.SessionLocal() as session:
        first = mark_stale_payments(session, now=now, stale_after=STALE_AFTER)
        updated_at = first[0].updated_at
    with database.SessionLocal() as session:
        second = mark_stale_payments(session, now=now + timedelta(hours=1), stale_after=STALE_AFTER)

    stored = _row(transaction_id)
    assert [row.transaction_id for row in first] == [transaction_id]
    assert second == []
    assert stored.status == "PROCESSING"
    assert stored.reconciliation_required is True
    assert stored.created_at == created_at
    assert stored.updated_at == updated_at
    assert calls == []

    response = client.post("/api/admin/reconcile")
    assert response.status_code == 200
    assert response.json()["marked"] == 0
    assert calls == []
