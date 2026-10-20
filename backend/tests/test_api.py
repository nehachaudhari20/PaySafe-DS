"""Payment API behavior against an isolated SQLite database."""

from decimal import Decimal

from sqlalchemy import select

from api.coordinator_client import CoordinatorTimeout, WorkersUnavailable
from paysafe.models import Payment


def _success(worker_id: str = "worker-b"):
    def process(transaction_id: str, amount: str, description: str) -> dict:
        return {
            "transaction_id": transaction_id,
            "status": "SUCCESS",
            "worker_id": worker_id,
            "message": "Simulated payment processed.",
        }

    return process


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_create_payment_persists_worker_result(client, monkeypatch):
    monkeypatch.setattr("api.main.coordinator_client.process", _success("worker-b"))

    response = client.post("/api/payments", json={"amount": "12.50", "description": "Lab fee"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "SUCCESS"
    assert body["worker_id"] == "worker-b"
    assert body["amount"] == "12.50"
    assert body["description"] == "Lab fee"
    assert body["transaction_id"].startswith("TXN-")

    listed = client.get("/api/payments")
    assert listed.status_code == 200
    assert listed.json()[0]["transaction_id"] == body["transaction_id"]

    found = client.get(f"/api/payments/{body['transaction_id']}")
    assert found.status_code == 200
    assert found.json()["worker_id"] == "worker-b"

    import paysafe.db as database

    assert database.SessionLocal is not None
    with database.SessionLocal() as session:
        stored = session.scalar(select(Payment).where(Payment.transaction_id == body["transaction_id"]))
        assert stored is not None
        assert stored.status == "SUCCESS"
        assert stored.worker_id == "worker-b"
        assert stored.amount == Decimal("12.50")


def test_recent_payments_are_newest_first(client, monkeypatch):
    monkeypatch.setattr("api.main.coordinator_client.process", _success("worker-a"))
    client.post("/api/payments", json={"amount": "1.00", "description": "first"})
    client.post("/api/payments", json={"amount": "2.00", "description": "second"})

    descriptions = [row["description"] for row in client.get("/api/payments").json()]
    assert descriptions == ["second", "first"]


def test_missing_payment_returns_404(client):
    response = client.get("/api/payments/TXN-MISSING")
    assert response.status_code == 404
    assert response.json()["detail"] == "Payment not found."


def test_invalid_payment_is_rejected_without_calling_coordinator(client, monkeypatch):
    def explode(transaction_id: str, amount: str, description: str) -> dict:
        raise AssertionError("coordinator should not be called")

    monkeypatch.setattr("api.main.coordinator_client.process", explode)
    response = client.post("/api/payments", json={"amount": "0", "description": "nope"})
    assert response.status_code == 422
    assert "greater than 0" in response.json()["detail"]
    assert client.get("/api/payments").json() == []


def test_unreachable_workers_mark_payment_failed(client, monkeypatch):
    def fail(transaction_id: str, amount: str, description: str) -> dict:
        raise WorkersUnavailable("No payment worker was reachable.")

    monkeypatch.setattr("api.main.coordinator_client.process", fail)
    response = client.post("/api/payments", json={"amount": "5.00", "description": "offline"})
    assert response.status_code == 503
    body = response.json()["detail"]
    assert body["message"] == "No payment worker was reachable."
    assert body["payment"]["status"] == "FAILED"
    assert body["payment"]["worker_id"] is None
    assert client.get("/api/payments").json()[0]["status"] == "FAILED"


def test_coordinator_timeout_leaves_payment_processing(client, monkeypatch):
    def timeout(transaction_id: str, amount: str, description: str) -> dict:
        raise CoordinatorTimeout("The coordinator did not respond in time. The payment may still be processing.")

    monkeypatch.setattr("api.main.coordinator_client.process", timeout)
    response = client.post("/api/payments", json={"amount": "5.00", "description": "slow"})
    assert response.status_code == 504
    body = response.json()["detail"]
    assert "may still be processing" in body["message"]
    assert body["payment"]["status"] == "PROCESSING"
    assert client.get("/api/payments").json()[0]["status"] == "PROCESSING"


def test_worker_health_reports_coordinator_state(client, monkeypatch):
    from api.coordinator_client import CoordinatorUnavailable

    monkeypatch.setattr(
        "api.main.coordinator_client.worker_health",
        lambda: {"workers": [{"worker_id": "worker-a", "reachable": True, "status": "SERVING"}]},
    )
    reachable = client.get("/api/workers/health")
    assert reachable.status_code == 200
    assert reachable.json()["coordinator_reachable"] is True
    assert reachable.json()["workers"][0]["worker_id"] == "worker-a"

    def down() -> dict:
        raise CoordinatorUnavailable("The coordinator is unavailable.")

    monkeypatch.setattr("api.main.coordinator_client.worker_health", down)
    unreachable = client.get("/api/workers/health")
    assert unreachable.json()["coordinator_reachable"] is False
    assert unreachable.json()["workers"] == []
