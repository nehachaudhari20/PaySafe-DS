"""Add Lamport logical time to payment execution events."""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005_lamport"
down_revision: Union[str, Sequence[str], None] = "004_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("payment_events", sa.Column("lamport_time", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("payment_events", "lamport_time")
