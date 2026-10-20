"""Durable coordinator leadership in PostgreSQL (term, lease, fencing)."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from paysafe.db import utcnow
from paysafe.models import CoordinatorLeadership

SINGLETON_KEY = 1


@dataclass(frozen=True)
class LeadershipState:
    leader_id: int
    term: int
    lease_expires_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class LeadershipClaim:
    leader_id: int
    term: int
    lease_expires_at: datetime


def read_leadership(db: Session) -> LeadershipState | None:
    row = db.get(CoordinatorLeadership, SINGLETON_KEY)
    if row is None:
        return None
    return LeadershipState(row.leader_id, row.term, row.lease_expires_at, row.updated_at)


def _aware(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment


def lease_is_valid(state: LeadershipState | None, *, now: datetime | None = None) -> bool:
    if state is None:
        return False
    moment = _aware(now or utcnow())
    return _aware(state.lease_expires_at) > moment


def try_claim_leadership(db: Session, coordinator_id: int, lease_seconds: float) -> LeadershipClaim | None:
    """Claim leadership with a new term when the lease is expired or missing.

    Returns None if another valid leader still holds the lease.
    """

    if coordinator_id <= 0:
        return None
    now = _aware(utcnow())
    lease = timedelta(seconds=max(1.0, lease_seconds))
    row = db.get(CoordinatorLeadership, SINGLETON_KEY, with_for_update=True)
    if row is None:
        claim = LeadershipClaim(coordinator_id, 1, now + lease)
        db.add(
            CoordinatorLeadership(
                id=SINGLETON_KEY,
                leader_id=claim.leader_id,
                term=claim.term,
                lease_expires_at=claim.lease_expires_at,
                updated_at=now,
            )
        )
        db.commit()
        return claim
    if _aware(row.lease_expires_at) > now:
        if row.leader_id != coordinator_id:
            db.rollback()
            return None
        row.lease_expires_at = now + lease
        row.updated_at = now
        db.commit()
        return LeadershipClaim(row.leader_id, row.term, row.lease_expires_at)
    new_term = row.term + 1
    row.leader_id = coordinator_id
    row.term = new_term
    row.lease_expires_at = now + lease
    row.updated_at = now
    db.commit()
    return LeadershipClaim(row.leader_id, row.term, row.lease_expires_at)


def renew_leadership_lease(db: Session, coordinator_id: int, term: int, lease_seconds: float) -> bool:
    """Extend the lease only for the current leader at the expected term."""

    now = _aware(utcnow())
    lease = timedelta(seconds=max(1.0, lease_seconds))
    row = db.get(CoordinatorLeadership, SINGLETON_KEY, with_for_update=True)
    if row is None or row.leader_id != coordinator_id or row.term != term:
        db.rollback()
        return False
    row.lease_expires_at = now + lease
    row.updated_at = now
    db.commit()
    return True


def validate_leadership_fence(db: Session, coordinator_id: int, term: int, *, now: datetime | None = None) -> bool:
    """True when this coordinator is the fenced leader for the given term."""

    state = read_leadership(db)
    moment = _aware(now or utcnow())
    return (
        state is not None
        and state.leader_id == coordinator_id
        and state.term == term
        and _aware(state.lease_expires_at) > moment
    )


def parse_coordinator_peers(raw: str) -> dict[int, str]:
    peers: dict[int, str] = {}
    for part in raw.split(","):
        item = part.strip()
        if not item or "=" not in item:
            continue
        left, address = item.split("=", 1)
        peer_id = int(left.strip())
        url = address.strip().rstrip("/")
        if not url.startswith("http"):
            url = f"http://{url}"
        peers[peer_id] = url
    return peers


def leader_base_url(db: Session, peers_raw: str, fallback_url: str) -> str:
    peers = parse_coordinator_peers(peers_raw)
    state = read_leadership(db)
    if state and state.leader_id in peers and lease_is_valid(state):
        return peers[state.leader_id]
    return fallback_url.rstrip("/")
