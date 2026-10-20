"""Add a persistent payment execution history."""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "004_events"
down_revision: Union[str, Sequence[str], None] = "003_retries"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "payment_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("transaction_id", sa.String(length=64), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("service", sa.String(length=32), nullable=False),
        sa.Column("worker_id", sa.String(length=64), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=True),
        sa.Column("message", sa.String(length=300), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=True),
    )
    op.create_index("ix_payment_events_transaction_id", "payment_events", ["transaction_id"])
    op.create_index("ix_payment_events_created_at", "payment_events", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_payment_events_created_at", table_name="payment_events")
    op.drop_index("ix_payment_events_transaction_id", table_name="payment_events")
    op.drop_table("payment_events")
