"""Bully coordinator election behavior."""

from unittest.mock import MagicMock, patch

import httpx
from fastapi.testclient import TestClient

from coordinator import main as coordinator_main
from coordinator.election import BullyElectionManager
from coordinator.election import election_manager as shared_manager


def test_lower_id_yields_when_higher_id_responds(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "1")
    monkeypatch.setenv("COORDINATOR_PEERS", "1=http://c1:8000,2=http://c2:8000,3=http://c3:8000")
    manager = BullyElectionManager()
    def respond(*_args, **_kwargs):
        return httpx.Response(200, request=MagicMock())

    with patch("coordinator.election.httpx.post", side_effect=respond) as post:
        with patch.object(manager, "_win_election") as win:
            manager._run_election("test")
    assert post.called
    win.assert_not_called()


def test_highest_id_wins_when_no_higher_peer_responds(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "3")
    monkeypatch.setenv("COORDINATOR_PEERS", "1=http://c1:8000,2=http://c2:8000,3=http://c3:8000")
    manager = BullyElectionManager()
    with patch.object(manager, "_win_election") as win:
        manager._run_election("test")
    win.assert_called_once()


def test_higher_id_starts_election_when_lower_id_contacts_it(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "2")
    monkeypatch.setenv("COORDINATOR_PEERS", "1=http://c1:8000,2=http://c2:8000")
    manager = BullyElectionManager()
    with patch.object(manager, "start_election") as start:
        manager.handle_election(1)
    start.assert_called_once()


def test_follower_rejects_authoritative_dispatch(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "2")
    monkeypatch.setenv("COORDINATOR_PEERS", "1=http://c1:8000,2=http://c2:8000")
    coordinator_main.router_holder["router"] = MagicMock()
    shared_manager._current_term = None
    with patch.object(shared_manager, "can_dispatch", return_value=False):
        with TestClient(coordinator_main.app) as test_client:
            response = test_client.post(
                "/process",
                json={"transaction_id": "TXN-ELECT", "amount": "10.00", "description": "blocked"},
            )
    assert response.status_code == 403
    assert response.json()["detail"]["not_leader"] is True
    coordinator_main.router_holder["router"] = None


def test_election_endpoint_returns_ok(client, monkeypatch):
    monkeypatch.setenv("COORDINATOR_ID", "2")
    with TestClient(coordinator_main.app) as test_client:
        response = test_client.post("/internal/bully/election", json={"from_id": 1})
    assert response.status_code == 200
