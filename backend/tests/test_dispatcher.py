"""Coordinator routing without a live network."""

import pytest

from coordinator.dispatcher import (
    AllWorkersUnreachable,
    ProcessOutcome,
    WorkerCallError,
    WorkerRouter,
    WorkerTarget,
    parse_workers,
)


def test_parse_workers():
    targets = parse_workers("worker-a=worker-a:50051, worker-b=worker-b:50051")
    assert [(item.worker_id, item.address) for item in targets] == [
        ("worker-a", "worker-a:50051"),
        ("worker-b", "worker-b:50051"),
    ]


@pytest.mark.parametrize("raw", ["", "   ", "worker-a", "worker-a="])
def test_parse_workers_rejects_bad_config(raw):
    with pytest.raises(ValueError):
        parse_workers(raw)


def test_round_robin_alternates_workers():
    calls: list[str] = []

    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        calls.append(worker_id)
        return ProcessOutcome(transaction_id, "SUCCESS", worker_id, "ok")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a:1"), WorkerTarget("worker-b", "b:1")],
        process_caller=process_caller,
    )
    router.process("t1", "1.00", "one")
    router.process("t2", "1.00", "two")
    router.process("t3", "1.00", "three")
    assert calls == ["worker-a", "worker-b", "worker-a"]


def test_unreachable_worker_falls_through_to_the_next():
    calls: list[str] = []

    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        calls.append(worker_id)
        if worker_id == "worker-a":
            raise WorkerCallError(f"{worker_id}: UNAVAILABLE")
        return ProcessOutcome(transaction_id, "SUCCESS", worker_id, "ok")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a"), WorkerTarget("worker-b", "b")],
        process_caller=process_caller,
    )
    outcome = router.process("t1", "1.00", "one")
    assert outcome.worker_id == "worker-b"
    assert calls == ["worker-a", "worker-b"]


def test_all_workers_unreachable():
    def process_caller(worker_id, address, transaction_id, amount, description, timeout):
        raise WorkerCallError(f"{worker_id}: UNAVAILABLE")

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a"), WorkerTarget("worker-b", "b")],
        process_caller=process_caller,
    )
    with pytest.raises(AllWorkersUnreachable):
        router.process("t1", "1.00", "one")


def test_health_marks_a_worker_unreachable():
    def health_caller(worker_id, address, timeout):
        if worker_id == "worker-b":
            raise WorkerCallError("down")
        return "SERVING"

    router = WorkerRouter(
        [WorkerTarget("worker-a", "a"), WorkerTarget("worker-b", "b")],
        health_caller=health_caller,
    )
    report = router.health()
    assert report == [
        {"worker_id": "worker-a", "reachable": True, "status": "SERVING"},
        {"worker_id": "worker-b", "reachable": False, "status": "UNREACHABLE"},
    ]
