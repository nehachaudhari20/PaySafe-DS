"""Simulated leader crash, leader wait in the API, and Lamport propagation over HTTP."""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from api.coordinator_client import NotCoordinatorLeader
from coordinator import main as coordinator_main
from coordinator.dispatcher import WorkerRouter, WorkerTarget
from coordinator.election import BullyElectionManager
from coordinator.election import election_manager as shared_manager


def test_simulated_crash_blocks_dispatch(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "3")
    manager = BullyElectionManager()
    manager._current_term = 4
    manager.simulate_crash(5)
    assert manager.is_crashed()
    assert manager.can_dispatch() is False
    assert manager.current_term is None


def test_crashed_coordinator_does_not_answer_election_messages(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "2")
    with patch.object(shared_manager, "is_crashed", return_value=True):
        with TestClient(coordinator_main.app) as test_client:
            election = test_client.post("/internal/bully/election", json={"from_id": 1})
            announce = test_client.post("/internal/bully/coordinator", json={"leader_id": 3, "term": 2})
    assert election.status_code == 503
    assert announce.status_code == 503


def test_crash_endpoint_requires_fault_injection(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "2")
    monkeypatch.setenv("FAULT_INJECTION_ENABLED", "false")
    with patch.object(shared_manager, "simulate_crash") as crash:
        with TestClient(coordinator_main.app) as test_client:
            response = test_client.post("/internal/dev/crash", json={"seconds": 5})
    assert response.status_code == 403
    crash.assert_not_called()


def test_router_merges_received_lamport_time():
    router = WorkerRouter([WorkerTarget("worker-a", "localhost:1")], process_caller=MagicMock())
    router.receive_lamport(70)
    assert router.lamport_time == 71


def test_api_sends_its_lamport_time_to_the_coordinator(client, monkeypatch):
    seen: dict[str, int] = {}

    def process(transaction_id, amount, description, *, base_url=None, lamport_time=0):
        seen["lamport_time"] = lamport_time
        return {"transaction_id": transaction_id, "status": "SUCCESS", "worker_id": "worker-a", "message": "ok"}

    monkeypatch.setattr("api.main.coordinator_client.process", process)
    response = client.post(
        "/api/payments",
        json={"amount": "10.00", "description": "lamport"},
        headers={"Idempotency-Key": "lamport-propagation-1"},
    )
    assert response.status_code == 200
    assert seen["lamport_time"] > 0


def test_api_waits_for_a_new_leader_after_not_leader(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_PEERS", "1=http://c1:8000,2=http://c2:8000")
    monkeypatch.setenv("LEADER_WAIT_SECONDS", "5")
    monkeypatch.setattr("api.main.time.sleep", lambda _seconds: None)
    calls = {"count": 0}

    def process(transaction_id, amount, description, *, base_url=None, lamport_time=0):
        calls["count"] += 1
        if calls["count"] == 1:
            raise NotCoordinatorLeader("not leader")
        return {"transaction_id": transaction_id, "status": "SUCCESS", "worker_id": "worker-b", "message": "ok"}

    monkeypatch.setattr("api.main.coordinator_client.process", process)
    response = client.post(
        "/api/payments",
        json={"amount": "11.00", "description": "failover"},
        headers={"Idempotency-Key": "leader-wait-1"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "SUCCESS"
    assert calls["count"] == 2
