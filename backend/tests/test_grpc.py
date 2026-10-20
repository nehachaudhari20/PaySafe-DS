"""In-process gRPC calls between the coordinator and a worker."""

from concurrent import futures

import grpc
from fastapi.testclient import TestClient

from coordinator import main as coordinator_main
from coordinator.dispatcher import WorkerRouter, WorkerTarget, grpc_health, grpc_process
from generated import payment_pb2_grpc
from worker.servicer import PaymentWorkerServicer


def start_worker(worker_id: str) -> tuple[grpc.Server, int]:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    payment_pb2_grpc.add_PaymentWorkerServicer_to_server(PaymentWorkerServicer(worker_id, 0), server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    return server, port


def test_worker_processes_payment_over_grpc():
    server, port = start_worker("worker-a")
    try:
        outcome = grpc_process("worker-a", f"127.0.0.1:{port}", "TXN-100", "10.00", "Books", 2.0)
        assert outcome.status == "SUCCESS"
        assert outcome.worker_id == "worker-a"
        assert outcome.transaction_id == "TXN-100"
        assert grpc_health("worker-a", f"127.0.0.1:{port}", 2.0) == "SERVING"
    finally:
        server.stop(0)


def test_coordinator_skips_an_unreachable_worker():
    server, port = start_worker("worker-b")
    coordinator_main.router_holder["router"] = WorkerRouter(
        [
            WorkerTarget("worker-a", "127.0.0.1:1"),
            WorkerTarget("worker-b", f"127.0.0.1:{port}"),
        ],
        timeout_seconds=0.8,
        health_timeout_seconds=0.5,
    )
    try:
        with TestClient(coordinator_main.app) as client:
            response = client.post(
                "/process",
                json={"transaction_id": "TXN-200", "amount": "15.00", "description": "Demo"},
            )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "SUCCESS"
        assert body["worker_id"] == "worker-b"
        assert body["transaction_id"] == "TXN-200"
    finally:
        coordinator_main.router_holder["router"] = None
        server.stop(0)
