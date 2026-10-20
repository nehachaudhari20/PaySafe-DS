"""Persist coordinator election observations for the demo."""

from sqlalchemy.orm import Session

from paysafe.db import utcnow
from paysafe.models import CoordinatorElectionEvent

EVENT_TYPES = {
    "ELECTION_STARTED",
    "ELECTION_RESPONSE_RECEIVED",
    "ELECTION_YIELDED",
    "LEADER_ANNOUNCED",
    "HEARTBEAT_RENEWED",
    "HEARTBEAT_TIMEOUT",
    "LEADERSHIP_CHANGED",
    "FENCING_REJECTED",
}


def record_election_event(
    db: Session,
    *,
    coordinator_id: int,
    event_type: str,
    message: str,
    term: int | None = None,
    peer_id: int | None = None,
) -> None:
    if event_type not in EVENT_TYPES:
        raise ValueError(f"Unknown election event type {event_type}.")
    db.add(
        CoordinatorElectionEvent(
            coordinator_id=coordinator_id,
            event_type=event_type,
            message=message[:300],
            term=term,
            peer_id=peer_id,
            created_at=utcnow(),
        )
    )
    db.commit()
