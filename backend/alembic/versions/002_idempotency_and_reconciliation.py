"""Add idempotency fields and a reconciliation flag."""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002_idempotency"
down_revision: Union[str, Sequence[str], None] = "001_create_payments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("payments", sa.Column("idempotency_key", sa.String(length=128), nullable=True))
    op.add_column("payments", sa.Column("request_fingerprint", sa.String(length=64), nullable=True))
    op.add_column(
        "payments",
        sa.Column("reconciliation_required", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_payments_idempotency_key", "payments", ["idempotency_key"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_payments_idempotency_key", table_name="payments")
    op.drop_column("payments", "reconciliation_required")
    op.drop_column("payments", "request_fingerprint")
    op.drop_column("payments", "idempotency_key")
