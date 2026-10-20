"""Lamport logical clock for ordering distributed events within this demo.

This does not guarantee exactly-once execution or a total order of all concurrent
events across the whole system. Each process keeps its own counter.
"""

import threading


class LamportClock:
    """Thread-safe Lamport clock with an integer counter."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = 0

    @property
    def current(self) -> int:
        with self._lock:
            return self._value

    def tick(self) -> int:
        """Advance on a local event and return the new value."""

        with self._lock:
            self._value += 1
            return self._value

    def receive(self, received: int) -> int:
        """Apply Lamport's rule: max(local, received) + 1."""

        with self._lock:
            incoming = max(0, int(received))
            self._value = max(self._value, incoming) + 1
            return self._value

    def reset(self) -> None:
        """Clear the counter. Used by tests only."""

        with self._lock:
            self._value = 0
