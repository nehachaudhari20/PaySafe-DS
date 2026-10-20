"""Leadership term, lease, and fencing."""

from datetime import timedelta

import paysafe.db as database
from paysafe.db import utcnow
from paysafe.leadership import (
    lease_is_valid,
    read_leadership,
    renew_leadership_lease,
    try_claim_leadership,
    validate_leadership_fence,
)
from paysafe.models import CoordinatorLeadership


def _session():
    assert database.SessionLocal is not None
    return database.SessionLocal()


def test_highest_claim_wins_when_lease_is_expired(client):
    db = _session()
    first = try_claim_leadership(db, 1, 0.1)
    assert first is not None
    assert first.leader_id == 1
    assert first.term == 1
    blocked = try_claim_leadership(db, 3, 2.0)
    assert blocked is None
    stored = db.get(CoordinatorLeadership, 1)
    assert stored is not None
    stored.lease_expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    winner = try_claim_leadership(db, 3, 2.0)
    assert winner is not None
    assert winner.leader_id == 3
    assert winner.term == 2


def test_renew_requires_matching_term(client):
    db = _session()
    claim = try_claim_leadership(db, 2, 3.0)
    assert claim is not None
    assert renew_leadership_lease(db, 2, claim.term, 3.0) is True
    assert renew_leadership_lease(db, 2, claim.term + 1, 3.0) is False


def test_stale_term_is_rejected_by_fencing(client):
    db = _session()
    claim = try_claim_leadership(db, 2, 3.0)
    assert claim is not None
    assert validate_leadership_fence(db, 2, claim.term) is True
    assert validate_leadership_fence(db, 2, claim.term - 1) is False
    assert validate_leadership_fence(db, 1, claim.term) is False


def test_lease_validity(client):
    db = _session()
    try_claim_leadership(db, 1, 5.0)
    state = read_leadership(db)
    assert state is not None
    assert lease_is_valid(state) is True
