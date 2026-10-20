"""Lamport logical clocks and their propagation over gRPC."""

from concurrent import futures

import grpc

from coordinator.dispatcher import WorkerRouter, WorkerTarget, grpc_process
from generated import payment_pb2, payment_pb2_grpc
from paysafe.api_clock import api_clock
from paysafe.lamport import LamportClock
from worker.servicer import PaymentWorkerServicer


def test_lamport_tick_increments():
    clock = LamportClock()
    assert clock.tick() == 1
    assert clock.tick() == 2
    assert clock.current == 2


def test_lamport_receive_merges_ahead_of_local():
    clock = LamportClock()
    clock.tick()
    clock.tick()
    assert clock.receive(10) == 11
    assert clock.current == 11


def test_lamport_receive_from_zero_still_advances():
    clock = LamportClock()
    assert clock.receive(0) == 1


def start_worker(worker_id: str) -> tuple[grpc.Server, int, PaymentWorkerServicer]:
    servicer = PaymentWorkerServicer(worker_id, 0)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    payment_pb2_grpc.add_PaymentWorkerServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    return server, port, servicer


def test_grpc_process_propagates_lamport_timestamps():
    server, port, servicer = start_worker("worker-a")
    coordinator_clock = LamportClock()
    try:
        grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-LAMPORT", "10.00", "Books", 2.0, clock=coordinator_clock)
        assert coordinator_clock.current >= 2
        assert servicer._lamport.current >= 2
    finally:
        server.stop(0)


def test_coordinator_trace_carries_lamport_values():
    server, port, _servicer = start_worker("worker-b")
    router = WorkerRouter([WorkerTarget("worker-b", f"127.0.0.1:{port}")], timeout_seconds=2.0)
    try:
        outcome = router.process("TXN-TRACE-LAMPORT", "12.00", "Clock demo")
        assert outcome.status == "SUCCESS"
        assert outcome.trace
        assert all(item.lamport_time > 0 for item in outcome.trace)
        assert router.lamport_time > 0
    finally:
        server.stop(0)


def test_successful_payment_events_store_lamport_times(client, monkeypatch):
    api_clock.reset()

    def fake_process(**_kwargs):
        return {
            "transaction_id": "TXN-LAMPORT-EVENT",
            "status": "SUCCESS",
            "worker_id": "worker-a",
            "message": "ok",
            "attempt_count": 1,
            "lamport_time": 7,
            "trace": [
                {
                    "attempt": 1,
                    "worker_id": "worker-a",
                    "event": "WORKER_SELECTED",
                    "message": "Selected worker-a.",
                    "lamport_time": 3,
                },
                {
                    "attempt": 1,
                    "worker_id": "worker-a",
                    "event": "ATTEMPT_STARTED",
                    "message": "Attempt 1 called worker-a.",
                    "lamport_time": 4,
                },
            ],
        }

    monkeypatch.setattr("api.main.coordinator_client.process", fake_process)
    response = client.post("/api/payments", json={"amount": "11.00", "description": "Lamport event test"})
    assert response.status_code == 200
    txn = response.json()["transaction_id"]
    events = client.get(f"/api/payments/{txn}/events").json()
    assert events[0]["event_type"] == "PAYMENT_RECEIVED"
    assert events[0]["lamport_time"] == 1
    coordinator_events = [event for event in events if event["service"] == "coordinator"]
    assert coordinator_events[0]["lamport_time"] == 3
    succeeded = next(event for event in events if event["event_type"] == "PAYMENT_SUCCEEDED")
    assert succeeded["lamport_time"] == 9
