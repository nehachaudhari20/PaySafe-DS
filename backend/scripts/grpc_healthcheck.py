"""Container health check for a payment worker."""

import os

import grpc

from generated import payment_pb2, payment_pb2_grpc

port = os.environ.get("GRPC_PORT", "50051")
channel = grpc.insecure_channel(
    f"127.0.0.1:{port}",
    options=[("grpc.enable_http_proxy", 0)],
)
stub = payment_pb2_grpc.PaymentWorkerStub(channel)
try:
    stub.CheckHealth(payment_pb2.HealthCheckRequest(), timeout=2)
finally:
    channel.close()
