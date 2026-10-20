"""Shared settings loaded from environment variables."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://paysafe:paysafe@localhost:5432/paysafe"
    coordinator_url: str = "http://localhost:8001"
    coordinator_timeout_seconds: float = 15.0
    workers: str = "worker-a=localhost:50051,worker-b=localhost:50052"
    worker_id: str = "worker"
    grpc_port: int = 50051
    process_delay_seconds: float = 0.6
    grpc_timeout_seconds: float = 5.0
    grpc_health_timeout_seconds: float = 1.0
    worker_max_attempts: int = 2
    worker_retry_delay_seconds: float = 0.2
    processing_stale_seconds: float = 30.0


def get_settings() -> Settings:
    return Settings()
