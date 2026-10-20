"""Run one payment worker process."""

from concurrent import futures
import logging
import os

import grpc

from generated import payment_pb2_grpc
from paysafe.config import get_settings
from worker.servicer import PaymentWorkerServicer
import paysafe.db as database

logger = logging.getLogger("paysafe.worker")


def serve() -> None:
    worker_id = os.environ.get("WORKER_ID", "").strip()
    if not worker_id:
        raise SystemExit("WORKER_ID is required.")
    settings = get_settings()
    database.configure_engine(settings.database_url)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8))
    payment_pb2_grpc.add_PaymentWorkerServicer_to_server(
        PaymentWorkerServicer(worker_id, settings.process_delay_seconds, session_factory=database.SessionLocal),
        server,
    )
    address = f"0.0.0.0:{settings.grpc_port}"
    server.add_insecure_port(address)
    server.start()
    logger.info("Worker %s listening on %s", worker_id, address)
    server.wait_for_termination()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    serve()
