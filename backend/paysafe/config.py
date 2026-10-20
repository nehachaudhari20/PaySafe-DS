"""Shared settings loaded from environment variables."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://paysafe:paysafe@localhost:5432/paysafe"
    coordinator_url: str = "http://localhost:8001"
    coordinator_timeout_seconds: float = 15.0
    coordinator_id: int = 0
    coordinator_peers: str = ""
    leadership_lease_seconds: float = 5.0
    leadership_heartbeat_seconds: float = 1.5
    election_response_timeout_seconds: float = 0.6
    election_cooldown_seconds: float = 1.0
    workers: str = "worker-a=localhost:50051,worker-b=localhost:50052"
    worker_id: str = "worker"
    grpc_port: int = 50051
    process_delay_seconds: float = 0.6
    grpc_timeout_seconds: float = 5.0
    grpc_health_timeout_seconds: float = 1.0
    worker_max_attempts: int = 2
    worker_retry_delay_seconds: float = 0.2
    processing_stale_seconds: float = 30.0
    fault_injection_enabled: bool = False


def get_settings() -> Settings:
    return Settings()
