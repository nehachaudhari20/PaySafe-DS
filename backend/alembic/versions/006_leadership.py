"""Coordinator Bully leadership, lease, and election events."""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "006_leadership"
down_revision: Union[str, Sequence[str], None] = "005_lamport"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "coordinator_leadership",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("leader_id", sa.Integer(), nullable=False),
        sa.Column("term", sa.Integer(), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "coordinator_election_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("coordinator_id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("message", sa.String(length=300), nullable=False),
        sa.Column("term", sa.Integer(), nullable=True),
        sa.Column("peer_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_coordinator_election_events_created_at", "coordinator_election_events", ["created_at"])
    op.create_index("ix_coordinator_election_events_coordinator_id", "coordinator_election_events", ["coordinator_id"])


def downgrade() -> None:
    op.drop_index("ix_coordinator_election_events_coordinator_id", table_name="coordinator_election_events")
    op.drop_index("ix_coordinator_election_events_created_at", table_name="coordinator_election_events")
    op.drop_table("coordinator_election_events")
    op.drop_table("coordinator_leadership")
