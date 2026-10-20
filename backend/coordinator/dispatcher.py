"""Round-robin routing from the coordinator to payment workers over gRPC."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import logging
import threading

import grpc

from generated import payment_pb2, payment_pb2_grpc

logger = logging.getLogger("paysafe.coordinator")

_CHANNEL_OPTIONS = [("grpc.enable_http_proxy", 0)]


@dataclass(frozen=True)
class WorkerTarget:
    worker_id: str
    address: str


@dataclass(frozen=True)
class ProcessOutcome:
    transaction_id: str
    status: str
    worker_id: str
    message: str


class WorkerCallError(Exception):
    """A worker could not be reached or failed the RPC."""


class AllWorkersUnreachable(Exception):
    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors) if errors else "No payment worker was reachable.")


def parse_workers(raw: str) -> list[WorkerTarget]:
    targets: list[WorkerTarget] = []
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        if "=" not in item:
            raise ValueError(f"Worker entry '{item}' must look like worker-a=host:50051.")
        worker_id, address = item.split("=", 1)
        worker_id = worker_id.strip()
        address = address.strip()
        if not worker_id or not address:
            raise ValueError(f"Worker entry '{item}' is missing an id or address.")
        targets.append(WorkerTarget(worker_id, address))
    if not targets:
        raise ValueError("At least one worker is required.")
    return targets


def grpc_process(
    worker_id: str,
    address: str,
    transaction_id: str,
    amount: str,
    description: str,
    timeout: float,
) -> ProcessOutcome:
    channel = grpc.insecure_channel(address, options=_CHANNEL_OPTIONS)
    try:
        stub = payment_pb2_grpc.PaymentWorkerStub(channel)
        response = stub.ProcessPayment(
            payment_pb2.ProcessPaymentRequest(
                transaction_id=transaction_id,
                amount=amount,
                description=description,
            ),
            timeout=timeout,
        )
    except grpc.RpcError as exc:
        code = exc.code().name if hasattr(exc, "code") else "UNAVAILABLE"
        raise WorkerCallError(f"{worker_id}: {code}") from exc
    finally:
        channel.close()
    if response.worker_id and response.worker_id != worker_id:
        logger.warning("Worker reported id %s but was called as %s", response.worker_id, worker_id)
    return ProcessOutcome(
        transaction_id=response.transaction_id or transaction_id,
        status=response.status or "FAILED",
        worker_id=worker_id,
        message=response.message or "Worker returned no message.",
    )


def grpc_health(worker_id: str, address: str, timeout: float) -> str:
    channel = grpc.insecure_channel(address, options=_CHANNEL_OPTIONS)
    try:
        stub = payment_pb2_grpc.PaymentWorkerStub(channel)
        response = stub.CheckHealth(payment_pb2.HealthCheckRequest(), timeout=timeout)
    except grpc.RpcError as exc:
        code = exc.code().name if hasattr(exc, "code") else "UNAVAILABLE"
        raise WorkerCallError(f"{worker_id}: {code}") from exc
    finally:
        channel.close()
    return response.status or "SERVING"


class WorkerRouter:
    """Pick the next worker, and try the others if that call cannot be completed."""

    def __init__(
        self,
        targets: list[WorkerTarget],
        process_caller=grpc_process,
        health_caller=grpc_health,
        timeout_seconds: float = 5.0,
        health_timeout_seconds: float = 1.0,
    ) -> None:
        if not targets:
            raise ValueError("At least one worker is required.")
        self.targets = list(targets)
        self._process_caller = process_caller
        self._health_caller = health_caller
        self.timeout_seconds = timeout_seconds
        self.health_timeout_seconds = health_timeout_seconds
        self._index = 0
        self._lock = threading.Lock()

    def _ordered_targets(self) -> list[WorkerTarget]:
        with self._lock:
            start = self._index
            self._index = (self._index + 1) % len(self.targets)
        count = len(self.targets)
        return [self.targets[(start + offset) % count] for offset in range(count)]

    def process(self, transaction_id: str, amount: str, description: str) -> ProcessOutcome:
        errors: list[str] = []
        for target in self._ordered_targets():
            try:
                return self._process_caller(
                    target.worker_id,
                    target.address,
                    transaction_id,
                    amount,
                    description,
                    self.timeout_seconds,
                )
            except WorkerCallError as exc:
                errors.append(str(exc))
        raise AllWorkersUnreachable(errors)

    def health(self) -> list[dict[str, object]]:
        with ThreadPoolExecutor(max_workers=len(self.targets)) as pool:
            return list(pool.map(self._check, self.targets))

    def _check(self, target: WorkerTarget) -> dict[str, object]:
        try:
            status = self._health_caller(target.worker_id, target.address, self.health_timeout_seconds)
        except WorkerCallError:
            return {"worker_id": target.worker_id, "reachable": False, "status": "UNREACHABLE"}
        return {"worker_id": target.worker_id, "reachable": True, "status": status}
