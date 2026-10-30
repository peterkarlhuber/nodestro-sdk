"""The HTTP layer shared by both clients: timeouts, retries, errors and Server-Sent Events."""

from __future__ import annotations

from collections.abc import Callable, Generator, Iterator, Mapping
from dataclasses import dataclass
import json
import math
import random
import time
from typing import Any, TypeVar
from urllib.parse import quote, urlsplit

import httpx

from .errors import NodestroAPIError, NodestroClientError, NodestroConnectionError, NodestroTimeoutError

#: Answers worth retrying: the server is starting, overloaded or a proxy failed.
RETRY_STATUS = frozenset({502, 503, 504})
#: Methods that never change anything; only these (and requests with an idempotency key) are retried.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def path_segment(value: object) -> str:
    """One path segment, percent-encoded (an id with ``/``, ``?`` or ``#`` cannot change the path).

    ``""``, ``.`` and ``..`` are refused: URL normalization would turn them into a different
    endpoint (``/api/runs/..`` is ``/api``), and no id or slug of the API has these values.
    """
    text = str(value)
    if text in ("", ".", ".."):
        raise ValueError(f"{text!r} is not a valid id: ids and slugs cannot be empty, '.' or '..'")
    return quote(text, safe="")


def base_url_of(url: str) -> str:
    """The base URL without a trailing slash; refuses what cannot be the address of a Nodestro API."""
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"The base URL must start with http:// or https:// and name a host, not {url!r}")
    if parts.query or parts.fragment:
        raise ValueError("The base URL cannot have a query (?) or fragment (#)")
    if parts.username is not None or parts.password is not None:
        raise ValueError("The base URL cannot contain credentials; pass them as headers")
    return parts.geturl().rstrip("/")


def _positive(name: str, value: float | None) -> None:
    if value is not None and (isinstance(value, bool) or not math.isfinite(value) or value <= 0):
        raise ValueError(f"{name} must be a positive number of seconds, not {value!r}")


@dataclass(frozen=True)
class RetryPolicy:
    """How often and how long to retry; ``attempts`` counts the first try (``1`` = never retry).

    The pause before retry ``n`` is ``backoff * 2 ** (n - 1)`` seconds, capped at ``max_backoff``
    and varied by ±25 % so that many clients do not retry in step.
    """

    attempts: int = 3
    backoff: float = 0.5
    max_backoff: float = 8.0

    def __post_init__(self) -> None:
        if isinstance(self.attempts, bool) or not isinstance(self.attempts, int) or self.attempts < 1:
            raise ValueError(f"RetryPolicy.attempts must be an integer of at least 1, not {self.attempts!r}")
        for name in ("backoff", "max_backoff"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f"RetryPolicy.{name} must be a finite number of seconds >= 0, not {value!r}")

    def delay(self, attempt: int) -> float:
        # min() before the power would overflow: 2 ** 2000 is fine for int, not for float.
        exponent = min(attempt - 1, 64)
        base: float = min(self.max_backoff, self.backoff * (2**exponent))
        return base * (0.75 + random.random() / 2)


T = TypeVar("T")


def poll_until(fetch: Callable[[], T], done: Callable[[T], bool], *, run_id: str, timeout: float, poll: float) -> T:
    """Call ``fetch`` every ``poll`` seconds until ``done``; at most ``timeout`` seconds in total."""
    if isinstance(poll, bool) or not math.isfinite(poll) or poll <= 0:
        raise ValueError(f"poll must be a positive number of seconds, not {poll!r}")
    if isinstance(timeout, bool) or not math.isfinite(timeout) or timeout < 0:
        raise ValueError(f"timeout must be a number of seconds >= 0, not {timeout!r}")
    deadline = time.monotonic() + timeout
    while True:
        found = fetch()
        if done(found):
            return found
        left = deadline - time.monotonic()
        if left <= 0:
            state = found.get("status") if isinstance(found, dict) else None
            raise NodestroTimeoutError(f"Run {run_id} is still {state} after {timeout:g} s")
        time.sleep(min(poll, left))


@dataclass
class Event:
    """One Server-Sent Event: its name (``event``), id and decoded JSON data."""

    event: str
    data: Any
    id: str | None = None


class Transport:
    """Sends the requests of one client.

    The headers given here (e.g. the API key) are added to every request and never stored on a
    caller's ``httpx.Client``, so one client can be shared by several Nodestro clients and is not
    closed by them.
    """

    def __init__(
        self,
        base_url: str,
        *,
        headers: Mapping[str, str] | None = None,
        timeout: float = 30.0,
        retry: RetryPolicy | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        _positive("timeout", timeout)
        self.base_url = base_url_of(base_url)
        self.retry = retry or RetryPolicy()
        self.timeout = timeout
        self.headers = httpx.Headers(dict(headers or {}))
        self._owned = client is None
        self.client = client or httpx.Client(timeout=timeout)

    def close(self) -> None:
        if self._owned:
            self.client.close()

    def _headers(self, extra: Mapping[str, str] | None) -> httpx.Headers:
        merged = httpx.Headers(self.headers)
        merged.update(dict(extra or {}))
        return merged

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
        query = {key: value for key, value in (params or {}).items() if value is not None}
        url = self.base_url + path
        sent_headers = self._headers(headers)
        error: NodestroClientError = NodestroConnectionError(f"{method} {path}: no answer")
        for attempt in range(1, attempts + 1):
            try:
                response = self.client.request(
                    method,
                    url,
                    json=json_body,
                    params=query,
                    headers=sent_headers,
                    files=files,
                    data=data,
                    timeout=timeout if timeout is not None else self.timeout,
                )
            except httpx.TimeoutException as exc:
                error = NodestroTimeoutError(f"{method} {path}: no answer within the time limit")
                error.__cause__ = exc
            except httpx.TransportError as exc:
                error = NodestroConnectionError(f"{method} {path}: {exc}")
                error.__cause__ = exc
            else:
                if response.status_code not in RETRY_STATUS or attempt == attempts:
                    return self._checked(response)
                error = NodestroAPIError.from_response(response.status_code, None, response.text)
            if attempt < attempts:
                time.sleep(self.retry.delay(attempt))
        raise error

    @staticmethod
    def _checked(response: httpx.Response) -> httpx.Response:
        status = response.status_code
        if 300 <= status < 400:
            target = response.headers.get("location", "")
            raise NodestroAPIError(
                status,
                "http_redirect",
                f"The server redirects to {target[:300]!r}; use the final address as the base URL "
                "(redirects are not followed, so a key is never sent elsewhere)",
            )
        if status < 400:
            return response
        try:
            body: Any = response.json()
        except ValueError:
            body = None
        raise NodestroAPIError.from_response(status, body, response.text)

    def json(self, method: str, path: str, **options: Any) -> Any:
        response = self.request(method, path, **options)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            kind = response.headers.get("content-type", "no content type")
            raise NodestroClientError(
                f"{method} {path}: the answer is not JSON ({kind}); is the base URL a Nodestro API?"
            ) from exc

    def events(
        self, path: str, *, headers: Mapping[str, str] | None = None, timeout: float | None = None
    ) -> Generator[Event, None, None]:
        """Server-Sent Events of ``path`` until the server ends the stream (keep-alive comments skipped).

        ``timeout`` limits the wait for the next line (the API sends a keep-alive every 15 s);
        ``None`` waits as long as the stream stays open.
        """
        _positive("timeout", timeout)
        try:
            with self.client.stream(
                "GET",
                self.base_url + path,
                headers=self._headers({"Accept": "text/event-stream", **dict(headers or {})}),
                timeout=httpx.Timeout(self.timeout, read=timeout),
            ) as response:
                if response.status_code >= 300:
                    response.read()
                    self._checked(response)
                yield from parse_events(response.iter_lines())
        except httpx.TimeoutException as exc:
            raise NodestroTimeoutError(f"GET {path}: the event stream stalled") from exc
        except httpx.TransportError as exc:
            raise NodestroConnectionError(f"GET {path}: {exc}") from exc


def parse_events(lines: Iterator[str]) -> Generator[Event, None, None]:
    """Parse ``text/event-stream`` lines (WHATWG): ``event:``, ``data:`` (multi-line), ``id:``.

    An event is delivered at the blank line that ends it. Lines left when the stream ends without
    that blank line are an incomplete event (the connection broke) and are dropped, as the
    standard requires.
    """
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
        elif field == "id" and "\0" not in value_text:
            event_id = value_text
