"""Payment record stored in PostgreSQL."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, Float, Integer, Numeric, String, false
from sqlalchemy.orm import Mapped, mapped_column

from paysafe.db import Base

PENDING = "PENDING"
PROCESSING = "PROCESSING"
SUCCESS = "SUCCESS"
FAILED = "FAILED"
UNKNOWN = "UNKNOWN"


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    description: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(32), index=True)
    worker_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    request_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reconciliation_required: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    last_error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkerEffect(Base):
    """Durable simulated effect for one transaction id. Workers read this before doing the work again."""

    __tablename__ = "worker_effects"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    worker_id: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(String(300), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkerFault(Base):
    """Development-only fault switch. `normal` leaves the worker on its usual success path."""

    __tablename__ = "worker_faults"

    worker_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    mode: Mapped[str] = mapped_column(String(16), nullable=False, default="normal")
    delay_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
