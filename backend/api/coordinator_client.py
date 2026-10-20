"""HTTP client used by the payment API to reach the coordinator."""

from typing import Any

import httpx


class CoordinatorError(Exception):
    """Base error for coordinator calls."""


class CoordinatorUnavailable(CoordinatorError):
    """The coordinator could not be contacted."""


class CoordinatorTimeout(CoordinatorError):
    """The coordinator did not answer before the deadline."""


class CoordinatorUncertain(CoordinatorError):
    """The call did not finish with a confirmed payment result."""


class CoordinatorRejected(CoordinatorError):
    """The coordinator rejected the request."""


class WorkersUnavailable(CoordinatorError):
    """The coordinator reported that no worker accepted the payment."""


class CoordinatorClient:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def process(self, transaction_id: str, amount: str, description: str) -> dict[str, Any]:
        try:
            response = httpx.post(
                f"{self.base_url}/process",
                json={
                    "transaction_id": transaction_id,
                    "amount": amount,
                    "description": description,
                },
                timeout=self.timeout_seconds,
            )
        except httpx.ConnectError as exc:
            raise CoordinatorUnavailable("The coordinator is unavailable.") from exc
        except httpx.TimeoutException as exc:
            raise CoordinatorTimeout(
                "The coordinator did not respond in time. The payment may still be processing."
            ) from exc
        except httpx.HTTPError as exc:
            raise CoordinatorUncertain(
                "The coordinator response was not received. The payment may still be processing."
            ) from exc

        if response.status_code == 503:
            raise WorkersUnavailable(_detail_message(response) or "No payment worker was reachable.")
        if response.status_code >= 500:
            raise CoordinatorUncertain("The coordinator failed before confirming the payment result.")
        if response.status_code >= 400:
            raise CoordinatorRejected(_detail_message(response) or "The coordinator rejected the payment request.")

        try:
            payload = response.json()
        except ValueError as exc:
            raise CoordinatorUncertain("The coordinator returned an unreadable response.") from exc
        if not isinstance(payload, dict) or "status" not in payload:
            raise CoordinatorUncertain("The coordinator returned an incomplete response.")
        return payload

    def worker_health(self) -> dict[str, Any]:
        try:
            response = httpx.get(f"{self.base_url}/workers/health", timeout=self.timeout_seconds)
        except httpx.HTTPError as exc:
            raise CoordinatorUnavailable("The coordinator is unavailable.") from exc
        if response.status_code >= 400:
            raise CoordinatorUnavailable("The coordinator could not report worker health.")
        try:
            payload = response.json()
        except ValueError as exc:
            raise CoordinatorUnavailable("The coordinator returned an unreadable health response.") from exc
        if not isinstance(payload, dict):
            raise CoordinatorUnavailable("The coordinator returned an incomplete health response.")
        return payload


def _detail_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
        return str(detail["message"])
    return ""
