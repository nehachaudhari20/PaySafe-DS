"""Bully leader election among coordinator replicas."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import httpx

import paysafe.db as database
from paysafe.config import get_settings
from paysafe.election_events import record_election_event
from paysafe.leadership import (
    lease_is_valid,
    parse_coordinator_peers,
    read_leadership,
    renew_leadership_lease,
    try_claim_leadership,
    validate_leadership_fence,
)

logger = logging.getLogger("paysafe.coordinator.election")


@dataclass(frozen=True)
class Peer:
    coordinator_id: int
    base_url: str


class BullyElectionManager:
    """Run Bully elections and maintain the local leadership view."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._election_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._current_term: int | None = None
        self._last_election_at = 0.0
        self._coordinator_announced = threading.Event()
        self._crashed_until = 0.0

    @property
    def current_term(self) -> int | None:
        return self._current_term

    def is_crashed(self) -> bool:
        return time.monotonic() < self._crashed_until

    def simulate_crash(self, seconds: float) -> None:
        """Behave like a stopped process: no heartbeats, no election replies, no dispatch."""

        self._log_event("LEADERSHIP_CHANGED", f"Simulated crash for {seconds:g}s; heartbeats stop.", term=self._current_term)
        self._current_term = None
        self._crashed_until = time.monotonic() + seconds

    def start(self) -> None:
        settings = get_settings()
        if settings.coordinator_id <= 0:
            logger.info("Coordinator election disabled (COORDINATOR_ID is not set).")
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, name="coordinator-election", daemon=True)
        self._thread.start()
        self.start_election(reason="startup")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)

    def peers(self) -> list[Peer]:
        settings = get_settings()
        return [
            Peer(coordinator_id, base_url)
            for coordinator_id, base_url in sorted(parse_coordinator_peers(settings.coordinator_peers).items())
        ]

    def self_id(self) -> int:
        return get_settings().coordinator_id

    def can_dispatch(self) -> bool:
        settings = get_settings()
        if settings.coordinator_id <= 0:
            return True
        if self.is_crashed() or self._current_term is None:
            return False
        if database.SessionLocal is None:
            return False
        with database.SessionLocal() as session:
            return validate_leadership_fence(session, settings.coordinator_id, self._current_term)

    def start_election(self, *, reason: str) -> None:
        settings = get_settings()
        if settings.coordinator_id <= 0:
            return
        now = time.monotonic()
        with self._election_lock:
            if now - self._last_election_at < settings.election_cooldown_seconds:
                return
            self._last_election_at = now
        threading.Thread(target=self._run_election, args=(reason,), name="bully-election", daemon=True).start()

    def handle_election(self, from_id: int) -> None:
        settings = get_settings()
        if settings.coordinator_id <= 0:
            return
        self._log_event("ELECTION_RESPONSE_RECEIVED", f"Responded to election from coordinator {from_id}.", peer_id=from_id)
        if from_id < settings.coordinator_id:
            self.start_election(reason=f"higher-than-{from_id}")

    def handle_coordinator_announcement(self, leader_id: int, term: int) -> None:
        settings = get_settings()
        if leader_id == settings.coordinator_id:
            self._current_term = term
        else:
            self._current_term = None
        self._coordinator_announced.set()
        self._log_event(
            "LEADER_ANNOUNCED",
            f"Coordinator {leader_id} announced leadership for term {term}.",
            term=term,
            peer_id=leader_id,
        )

    def _run_loop(self) -> None:
        settings = get_settings()
        was_crashed = False
        while not self._stop.is_set():
            time.sleep(settings.leadership_heartbeat_seconds)
            if settings.coordinator_id <= 0 or database.SessionLocal is None:
                continue
            if self.is_crashed():
                was_crashed = True
                continue
            if was_crashed:
                was_crashed = False
                self.start_election(reason="rejoin-after-crash")
                continue
            with database.SessionLocal() as session:
                state = read_leadership(session)
                if state and state.leader_id == settings.coordinator_id and lease_is_valid(state):
                    if self._current_term is None:
                        self._current_term = state.term
                    if renew_leadership_lease(session, settings.coordinator_id, state.term, settings.leadership_lease_seconds):
                        self._log_event("HEARTBEAT_RENEWED", f"Renewed lease for term {state.term}.", term=state.term)
                    else:
                        self._log_event("LEADERSHIP_CHANGED", "Lease renewal failed; starting a new election.")
                        self.start_election(reason="renewal-failed")
                elif not lease_is_valid(state):
                    self._log_event("HEARTBEAT_TIMEOUT", "Leadership lease expired or missing; starting election.")
                    self.start_election(reason="lease-expired")

    def _run_election(self, reason: str) -> None:
        settings = get_settings()
        self._coordinator_announced.clear()
        self._log_event("ELECTION_STARTED", f"Bully election started ({reason}).")
        higher = [peer for peer in self.peers() if peer.coordinator_id > settings.coordinator_id]
        got_response = False
        for peer in higher:
            if self._send_election(peer):
                got_response = True
        if got_response:
            self._log_event("ELECTION_YIELDED", "A higher coordinator responded; waiting for its leadership announcement.")
            if not self._coordinator_announced.wait(timeout=settings.election_response_timeout_seconds):
                self.start_election(reason="announce-timeout")
            return
        self._win_election()

    def _win_election(self) -> None:
        settings = get_settings()
        if database.SessionLocal is None:
            return
        with database.SessionLocal() as session:
            claim = try_claim_leadership(session, settings.coordinator_id, settings.leadership_lease_seconds)
        if claim is None:
            self._log_event("LEADERSHIP_CHANGED", "Could not claim leadership in PostgreSQL.")
            return
        self._current_term = claim.term
        self._log_event("LEADER_ANNOUNCED", f"This coordinator became leader for term {claim.term}.", term=claim.term)
        logger.info("Coordinator %s became leader for term %s", settings.coordinator_id, claim.term)
        for peer in self.peers():
            if peer.coordinator_id < settings.coordinator_id:
                self._announce(peer, claim.leader_id, claim.term)

    def _send_election(self, peer: Peer) -> bool:
        settings = get_settings()
        try:
            response = httpx.post(
                f"{peer.base_url}/internal/bully/election",
                json={"from_id": settings.coordinator_id},
                timeout=settings.election_response_timeout_seconds,
            )
        except httpx.HTTPError:
            return False
        return response.status_code == 200

    def _announce(self, peer: Peer, leader_id: int, term: int) -> None:
        settings = get_settings()
        try:
            httpx.post(
                f"{peer.base_url}/internal/bully/coordinator",
                json={"leader_id": leader_id, "term": term},
                timeout=settings.election_response_timeout_seconds,
            )
        except httpx.HTTPError:
            logger.warning("Could not announce leadership to coordinator %s", peer.coordinator_id)

    def _log_event(self, event_type: str, message: str, *, term: int | None = None, peer_id: int | None = None) -> None:
        settings = get_settings()
        if database.SessionLocal is None:
            logger.info("%s: %s", event_type, message)
            return
        with database.SessionLocal() as session:
            record_election_event(
                session,
                coordinator_id=settings.coordinator_id,
                event_type=event_type,
                message=message,
                term=term,
                peer_id=peer_id,
            )


election_manager = BullyElectionManager()
