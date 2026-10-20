"""Logical clock for the payment API process."""

from paysafe.lamport import LamportClock

api_clock = LamportClock()
