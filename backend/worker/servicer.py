"""gRPC servicer that simulates payment processing."""

import logging
import time

import grpc

from generated import payment_pb2, payment_pb2_grpc

logger = logging.getLogger("paysafe.worker")


class PaymentWorkerServicer(payment_pb2_grpc.PaymentWorkerServicer):
    def __init__(self, worker_id: str, delay_seconds: float) -> None:
        self.worker_id = worker_id
        self.delay_seconds = delay_seconds

    def ProcessPayment(self, request, context):
        if not request.transaction_id:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "transaction_id is required")
        if self.delay_seconds > 0:
            time.sleep(self.delay_seconds)
        logger.info("Processed %s", request.transaction_id)
        return payment_pb2.ProcessPaymentResponse(
            transaction_id=request.transaction_id,
            status="SUCCESS",
            worker_id=self.worker_id,
            message="Simulated payment processed.",
        )

    def CheckHealth(self, request, context):
        return payment_pb2.HealthCheckResponse(worker_id=self.worker_id, status="SERVING")
