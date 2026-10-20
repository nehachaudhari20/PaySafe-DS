"""Add retry fields and durable worker effect records."""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003_retries"
down_revision: Union[str, Sequence[str], None] = "002_idempotency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("payments", sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("payments", sa.Column("last_error", sa.String(length=300), nullable=True))
    op.add_column("payments", sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "worker_effects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("transaction_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("worker_id", sa.String(length=64), nullable=False),
        sa.Column("message", sa.String(length=300), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_worker_effects_transaction_id", "worker_effects", ["transaction_id"], unique=True)
    op.create_table(
        "worker_faults",
        sa.Column("worker_id", sa.String(length=64), primary_key=True),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("delay_seconds", sa.Float(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("worker_faults")
    op.drop_index("ix_worker_effects_transaction_id", table_name="worker_effects")
    op.drop_table("worker_effects")
    op.drop_column("payments", "last_attempt_at")
    op.drop_column("payments", "last_error")
    op.drop_column("payments", "attempt_count")
