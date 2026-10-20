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


class NotCoordinatorLeader(CoordinatorError):
    """The coordinator rejected the call because it is not the fenced leader."""

    def __init__(self, message: str, leader_id: int | None = None, term: int | None = None) -> None:
        super().__init__(message)
        self.leader_id = leader_id
        self.term = term


class WorkersUnavailable(CoordinatorError):
    """The coordinator reported that no worker accepted the payment."""

    def __init__(
        self,
        message: str,
        attempt_count: int = 0,
        last_error: str | None = None,
        trace: list | None = None,
    ) -> None:
        super().__init__(message)
        self.attempt_count = attempt_count
        self.last_error = last_error
        self.trace = trace or []


class CoordinatorClient:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def process(
        self,
        transaction_id: str,
        amount: str,
        description: str,
        *,
        base_url: str | None = None,
        lamport_time: int = 0,
    ) -> dict[str, Any]:
        target = (base_url or self.base_url).rstrip("/")
        try:
            response = httpx.post(
                f"{target}/process",
                json={
                    "transaction_id": transaction_id,
                    "amount": amount,
                    "description": description,
                    "lamport_time": lamport_time,
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

        if response.status_code == 403:
            detail = _detail_payload(response)
            raise NotCoordinatorLeader(
                _message_from_detail(detail) or "The coordinator is not the current leader.",
                leader_id=detail.get("leader_id") if isinstance(detail.get("leader_id"), int) else None,
                term=detail.get("term") if isinstance(detail.get("term"), int) else None,
            )
        if response.status_code == 503:
            detail = _detail_payload(response)
            raise WorkersUnavailable(
                _message_from_detail(detail) or "No payment worker was reachable.",
                attempt_count=_attempt_count(detail),
                last_error=_optional_text(detail.get("last_error")),
                trace=_trace(detail),
            )
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

    def worker_health(self, *, base_url: str | None = None) -> dict[str, Any]:
        target = (base_url or self.base_url).rstrip("/")
        try:
            response = httpx.get(f"{target}/workers/health", timeout=self.timeout_seconds)
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


def _detail_payload(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {"message": response.text.strip()}
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        return detail
    if isinstance(detail, str):
        return {"message": detail}
    return {"message": response.text.strip()}


def _message_from_detail(detail: dict[str, Any]) -> str:
    message = detail.get("message")
    return message if isinstance(message, str) else ""


def _attempt_count(detail: dict[str, Any]) -> int:
    value = detail.get("attempt_count", 0)
    return value if isinstance(value, int) and value >= 0 else 0


def _trace(detail: dict[str, Any]) -> list[dict[str, Any]]:
    value = detail.get("trace")
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:300] if text else None


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
