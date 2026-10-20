"""gRPC servicer that simulates payment processing once per transaction id."""

import logging
import time
from collections.abc import Callable

import grpc
from sqlalchemy.orm import Session, sessionmaker

from generated import payment_pb2, payment_pb2_grpc
from paysafe.effects import claim_effect, complete_effect
from paysafe.faults import get_fault
from paysafe.lamport import LamportClock
from paysafe.models import FAILED, SUCCESS

logger = logging.getLogger("paysafe.worker")


class PaymentWorkerServicer(payment_pb2_grpc.PaymentWorkerServicer):
    def __init__(
        self,
        worker_id: str,
        delay_seconds: float,
        session_factory: sessionmaker[Session] | None = None,
        on_effect: Callable[[], None] | None = None,
    ) -> None:
        self.worker_id = worker_id
        self.delay_seconds = delay_seconds
        self.session_factory = session_factory
        self.on_effect = on_effect
        self._lamport = LamportClock()

    def ProcessPayment(self, request, context):
        if not request.transaction_id:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "transaction_id is required")
        received = int(getattr(request, "lamport_time", 0) or 0)
        if received > 0:
            self._lamport.receive(received)
        else:
            self._lamport.tick()
        if self.session_factory is None:
            self._pause(self.delay_seconds)
            self._apply_effect()
            logger.info("Processed %s", request.transaction_id)
            return self._response(request.transaction_id, "SUCCESS", "Simulated payment processed.", lamport_time=self._lamport.tick())

        try:
            mode, fault_delay = get_fault(self.session_factory, self.worker_id)
            owns_effect, existing = claim_effect(self.session_factory, request.transaction_id, self.worker_id)
            if not owns_effect:
                logger.info("Replayed %s as %s", request.transaction_id, existing.status)
                status = existing.status if existing.status in (SUCCESS, FAILED) else "PROCESSING"
                message = existing.message or "Payment is already in progress."
                return self._response(
                    request.transaction_id,
                    status,
                    message,
                    existing.worker_id,
                    lamport_time=self._lamport.tick(),
                )
            if mode == "fail":
                complete_effect(
                    self.session_factory,
                    request.transaction_id,
                    self.worker_id,
                    FAILED,
                    "Simulated processing failure.",
                )
                logger.info("Failed %s", request.transaction_id)
                return self._response(
                    request.transaction_id,
                    FAILED,
                    "Simulated processing failure.",
                    lamport_time=self._lamport.tick(),
                )

            delay = fault_delay if mode == "delay" and fault_delay > 0 else self.delay_seconds
            self._pause(delay)
            self._apply_effect()
            complete_effect(
                self.session_factory,
                request.transaction_id,
                self.worker_id,
                SUCCESS,
                "Simulated payment processed.",
            )
        except Exception as exc:
            logger.exception("Worker %s could not finish %s", self.worker_id, request.transaction_id)
            context.abort(grpc.StatusCode.UNAVAILABLE, "Worker could not finish the payment effect.")
            raise exc
        logger.info("Processed %s", request.transaction_id)
        return self._response(request.transaction_id, SUCCESS, "Simulated payment processed.", lamport_time=self._lamport.tick())

    def CheckHealth(self, request, context):
        return payment_pb2.HealthCheckResponse(worker_id=self.worker_id, status="SERVING")

    def _pause(self, delay: float) -> None:
        if delay > 0:
            time.sleep(delay)

    def _apply_effect(self) -> None:
        if self.on_effect is not None:
            self.on_effect()

    def _response(
        self,
        transaction_id: str,
        status: str,
        message: str,
        worker_id: str | None = None,
        *,
        lamport_time: int = 0,
    ):
        return payment_pb2.ProcessPaymentResponse(
            transaction_id=transaction_id,
            status=status,
            worker_id=worker_id or self.worker_id,
            message=message,
            lamport_time=lamport_time,
        )
