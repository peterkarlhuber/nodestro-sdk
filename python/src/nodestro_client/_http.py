"""The HTTP layer shared by both clients: timeouts, retries, errors and Server-Sent Events."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
import json
import random
import time
from typing import Any

import httpx

from .errors import NodestroAPIError, NodestroConnectionError, NodestroTimeoutError

#: Answers worth retrying: the server is starting, overloaded or a proxy failed.
RETRY_STATUS = frozenset({502, 503, 504})
#: Methods that never change anything; only these (and requests with an idempotency key) are retried.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class RetryPolicy:
    """How often and how long to retry; ``attempts`` counts the first try."""

    attempts: int = 3
    backoff: float = 0.5
    max_backoff: float = 8.0

    def delay(self, attempt: int) -> float:
        base: float = min(self.max_backoff, self.backoff * (2 ** (attempt - 1)))
        return base * (0.75 + random.random() / 2)


@dataclass
class Event:
    """One Server-Sent Event: its name (``event``), id and decoded JSON data."""

    event: str
    data: Any
    id: str | None = None


class Transport:
    def __init__(
        self,
        base_url: str,
        *,
        headers: Mapping[str, str] | None = None,
        timeout: float = 30.0,
        retry: RetryPolicy | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.retry = retry or RetryPolicy()
        self.timeout = timeout
        self._owned = client is None
        self.client = client or httpx.Client(base_url=self.base_url, timeout=timeout, headers=dict(headers or {}))
        if client is not None and headers:
            self.client.headers.update(headers)

    def close(self) -> None:
        if self._owned:
            self.client.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        files: Any = None,
        data: Any = None,
        timeout: float | None = None,
        retry_unsafe: bool = False,
    ) -> httpx.Response:
        """One request with retries for connection errors and 502/503/504.

        A request that may change something is only retried when ``retry_unsafe`` says it is safe
        (it carries an idempotency key, or the server refuses duplicates by itself).
        """
        retryable = method.upper() in SAFE_METHODS or retry_unsafe
        attempts = self.retry.attempts if retryable else 1
        last: Exception | None = None
        query = {key: value for key, value in (params or {}).items() if value is not None}
        for attempt in range(1, attempts + 1):
            try:
                response = self.client.request(
                    method,
                    path,
                    json=json_body,
                    params=query,
                    headers=dict(headers or {}),
                    files=files,
                    data=data,
                    timeout=timeout if timeout is not None else self.timeout,
                )
            except httpx.TimeoutException as exc:
                last = NodestroTimeoutError(f"{method} {path}: no answer within the time limit")
                last.__cause__ = exc
            except httpx.TransportError as exc:
                last = NodestroConnectionError(f"{method} {path}: {exc}")
                last.__cause__ = exc
            else:
                if response.status_code in RETRY_STATUS and attempt < attempts:
                    last = None
                else:
                    return self._checked(response)
            if attempt < attempts:
                time.sleep(self.retry.delay(attempt))
        assert last is not None or attempts > 0
        if last is None:  # pragma: no cover - the loop returns the last answer
            raise NodestroConnectionError(f"{method} {path}: no answer")
        raise last

    @staticmethod
    def _checked(response: httpx.Response) -> httpx.Response:
        if response.status_code < 400:
            return response
        try:
            body: Any = response.json()
        except ValueError:
            body = None
        raise NodestroAPIError.from_response(response.status_code, body, response.text)

    def json(self, method: str, path: str, **options: Any) -> Any:
        response = self.request(method, path, **options)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    def events(
        self, path: str, *, headers: Mapping[str, str] | None = None, timeout: float | None = None
    ) -> Iterator[Event]:
        """Server-Sent Events of ``path`` until the server ends the stream (keep-alive comments skipped)."""
        try:
            with self.client.stream(
                "GET",
                path,
                headers={"Accept": "text/event-stream", **dict(headers or {})},
                timeout=httpx.Timeout(self.timeout, read=timeout),
            ) as response:
                if response.status_code >= 400:
                    response.read()
                    self._checked(response)
                yield from parse_events(response.iter_lines())
        except httpx.TimeoutException as exc:
            raise NodestroTimeoutError(f"GET {path}: the event stream stalled") from exc
        except httpx.TransportError as exc:
            raise NodestroConnectionError(f"GET {path}: {exc}") from exc


def parse_events(lines: Iterator[str]) -> Iterator[Event]:
    """Parse ``text/event-stream`` lines (WHATWG): ``event:``, ``data:`` (multi-line), ``id:``."""
    name, event_id = "message", None
    data: list[str] = []
    for raw in lines:
        line = raw.rstrip("\r")
        if not line:
            if data:
                text = "\n".join(data)
                try:
                    value: Any = json.loads(text)
                except ValueError:
                    value = text
                yield Event(event=name, data=value, id=event_id)
            name, data = "message", []
            continue
        if line.startswith(":"):
            continue
        field, _, value_text = line.partition(":")
        value_text = value_text[1:] if value_text.startswith(" ") else value_text
        if field == "event":
            name = value_text
        elif field == "data":
            data.append(value_text)
        elif field == "id":
            event_id = value_text
