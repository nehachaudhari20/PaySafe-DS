"""Round-robin routing from the coordinator to payment workers over gRPC."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import logging
import threading
import time

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
    attempt_count: int = 0
    last_error: str = ""


class WorkerCallError(Exception):
    """A worker could not be reached or failed the RPC."""


class AllWorkersUnreachable(Exception):
    def __init__(self, errors: list[str], attempt_count: int = 0) -> None:
        self.errors = errors
        self.attempt_count = attempt_count
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
        max_attempts: int = 2,
        retry_delay_seconds: float = 0.0,
    ) -> None:
        if not targets:
            raise ValueError("At least one worker is required.")
        self.targets = list(targets)
        self._process_caller = process_caller
        self._health_caller = health_caller
        self.timeout_seconds = timeout_seconds
        self.health_timeout_seconds = health_timeout_seconds
        self.max_attempts = max(1, max_attempts)
        self.retry_delay_seconds = max(0.0, retry_delay_seconds)
        self._index = 0
        self._lock = threading.Lock()

    def _ordered_targets(self) -> list[WorkerTarget]:
        with self._lock:
            start = self._index
            self._index = (self._index + 1) % len(self.targets)
        count = len(self.targets)
        return [self.targets[(start + offset) % count] for offset in range(count)]

    def process(self, transaction_id: str, amount: str, description: str) -> ProcessOutcome:
        """Try workers in round-robin order, then retry communication failures a bounded number of times.

        A worker status of SUCCESS or FAILED is final. A deadline, a connection failure, or an
        in-progress effect can be retried with the same transaction id. If a deadline was seen and
        no final status arrives, the result is UNKNOWN rather than FAILED.
        """

        last_error = ""
        saw_deadline = False
        for attempt in range(1, self.max_attempts + 1):
            errors: list[str] = []
            in_progress: ProcessOutcome | None = None
            for target in self._ordered_targets():
                try:
                    outcome = self._process_caller(
                        target.worker_id,
                        target.address,
                        transaction_id,
                        amount,
                        description,
                        self.timeout_seconds,
                    )
                except WorkerCallError as exc:
                    message = str(exc)
                    errors.append(message)
                    if "DEADLINE_EXCEEDED" in message:
                        saw_deadline = True
                    continue
                if outcome.status in ("SUCCESS", "FAILED"):
                    return ProcessOutcome(
                        transaction_id=outcome.transaction_id or transaction_id,
                        status=outcome.status,
                        worker_id=outcome.worker_id,
                        message=outcome.message,
                        attempt_count=attempt,
                        last_error="",
                    )
                in_progress = outcome
                break
            if in_progress is not None:
                last_error = in_progress.message or "Payment is already in progress."
                if attempt >= self.max_attempts:
                    return ProcessOutcome(
                        transaction_id=transaction_id,
                        status="UNKNOWN",
                        worker_id=in_progress.worker_id,
                        message="The worker started this payment, but the result is not confirmed.",
                        attempt_count=attempt,
                        last_error=last_error,
                    )
            else:
                last_error = "; ".join(errors) if errors else "No payment worker was reachable."
                if attempt >= self.max_attempts:
                    if saw_deadline:
                        return ProcessOutcome(
                            transaction_id=transaction_id,
                            status="UNKNOWN",
                            worker_id="",
                            message="The worker did not answer before the deadline. The payment may already have been processed.",
                            attempt_count=attempt,
                            last_error=last_error,
                        )
                    raise AllWorkersUnreachable(errors or [last_error], attempt_count=attempt)
            logger.info("Retrying %s after attempt %s: %s", transaction_id, attempt, last_error)
            if self.retry_delay_seconds > 0:
                time.sleep(self.retry_delay_seconds)
        raise AllWorkersUnreachable([last_error] if last_error else [], attempt_count=self.max_attempts)

    def health(self) -> list[dict[str, object]]:
        with ThreadPoolExecutor(max_workers=len(self.targets)) as pool:
            return list(pool.map(self._check, self.targets))

    def _check(self, target: WorkerTarget) -> dict[str, object]:
        try:
            status = self._health_caller(target.worker_id, target.address, self.health_timeout_seconds)
        except WorkerCallError:
            return {"worker_id": target.worker_id, "reachable": False, "status": "UNREACHABLE"}
        return {"worker_id": target.worker_id, "reachable": True, "status": status}
