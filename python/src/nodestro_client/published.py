"""The client of a published workflow API (``/api/published/{slug}``), authenticated with a Nodestro key.

The same API is served by Nodestro itself (local or, when enabled, in the network) and by a
workflow exported as a standalone FastAPI project, so this client works with both.
"""

from __future__ import annotations

from collections.abc import Generator, Mapping
import math
from typing import Any, Literal, cast
import uuid

import httpx

from . import models
from ._http import Event, RetryPolicy, Transport, path_segment, poll_until
from .errors import NodestroRunFailed

PREFIX = "/api/published"
#: API states that end a run; ``awaiting_approval`` waits for a person.
FINISHED = frozenset({"succeeded", "failed", "cancelled"})
WAITING = "awaiting_approval"


class PublishedWorkflow:
    """One published workflow: start runs, follow them, decide approvals, read results and files.

    >>> with PublishedWorkflow("http://127.0.0.1:8000", "quote", api_key="ndk_...") as api:
    ...     run = api.start({"customer": "ACME"})
    ...     result = api.wait_for_result(run["run_id"])

    ``api_key`` is sent as ``Authorization: Bearer`` with every request of this client (never
    stored on a passed ``http_client``). What a key may do (``run``, ``read``, ``approve``) is
    decided by the server; a missing permission is a :class:`~nodestro_client.NodestroAPIError`
    with status 403. Use ``https://`` for any server that is not on this computer. The other
    options are those of :class:`~nodestro_client.NodestroClient`.
    """

    def __init__(
        self,
        base_url: str,
        slug: str,
        *,
        api_key: str,
        timeout: float = 30.0,
        retry: RetryPolicy | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip() or any(c in api_key for c in "\r\n"):
            raise ValueError("api_key must be the non-empty token of a Nodestro API key")
        self.slug = slug
        self._base = f"{PREFIX}/{path_segment(slug)}"
        self._http = Transport(
            base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout, retry=retry, client=http_client
        )

    def close(self) -> None:
        """Close the connections (only those of the client created here; safe to call twice)."""
        self._http.close()

    def __enter__(self) -> PublishedWorkflow:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def info(self) -> models.InfoOut:
        """What the API expects and returns: input fields, versions, limits, approvals."""
        return cast(models.InfoOut, self._http.json("GET", self._base))

    def openapi(self) -> dict[str, Any]:
        """The OpenAPI document of this workflow with its input and result schemas."""
        return cast(dict[str, Any], self._http.json("GET", f"{self._base}/openapi.json"))

    def start(
        self,
        values: Mapping[str, Any],
        *,
        version: int | None = None,
        idempotency_key: str | None = None,
        wait: float | None = None,
    ) -> models.RunStatusOut:
        """Start a run with the request body of the workflow: ``{"values": {...}}`` with the fields of
        its input form, or ``{"input": "..."}`` with free text (``openapi()`` describes the exact body).

        Every start carries an ``Idempotency-Key`` (a new random one unless given), so the
        automatic retry after a lost answer or a 502/503/504 returns the same run instead of
        starting a second one. Pass your own key (at most 200 characters, valid for 24 hours) to
        make your own retries safe too; the same key with different values is refused (409
        ``idempotency.conflict``). ``version`` starts a specific published version. ``wait``
        waits up to that many seconds for the result (only when the publication allows
        synchronous calls; the request timeout is extended by it).
        """
        path = f"{self._base}/versions/{path_segment(version)}/runs" if version is not None else f"{self._base}/runs"
        key = idempotency_key or uuid.uuid4().hex
        if wait is not None and (isinstance(wait, bool) or not math.isfinite(wait) or wait < 0):
            raise ValueError(f"wait must be a number of seconds >= 0, not {wait!r}")
        return cast(
            models.RunStatusOut,
            self._http.json(
                "POST",
                path,
                json_body=dict(values),
                params={"wait": wait},
                headers={"Idempotency-Key": key},
                timeout=self._http.timeout + wait if wait else None,
                retry_unsafe=True,
            ),
        )

    def runs(self, *, status: str | None = None, limit: int | None = None) -> list[models.RunStatusOut]:
        """The runs of this API, newest first (``status`` filters, e.g. ``awaiting_approval``)."""
        return cast(
            list[models.RunStatusOut],
            self._http.json("GET", f"{self._base}/runs", params={"status": status, "limit": limit}),
        )

    def status(self, run_id: str) -> models.RunStatusOut:
        return cast(models.RunStatusOut, self._http.json("GET", f"{self._base}/runs/{path_segment(run_id)}"))

    def result(self, run_id: str) -> models.RunResultOut:
        return cast(models.RunResultOut, self._http.json("GET", f"{self._base}/runs/{path_segment(run_id)}/result"))

    def wait(
        self, run_id: str, *, timeout: float = 300.0, poll: float = 0.5, stop_at_approval: bool = True
    ) -> models.RunStatusOut:
        """The status once the run finished (or waits for an approval, unless ``stop_at_approval`` is off).

        ``timeout`` (total seconds) and ``poll`` work as in :meth:`NodestroClient.wait_for_run`.
        """
        return poll_until(
            lambda: self.status(run_id),
            lambda found: found.get("status") in FINISHED or (stop_at_approval and found.get("status") == WAITING),
            run_id=run_id,
            timeout=timeout,
            poll=poll,
        )

    def wait_for_result(self, run_id: str, *, timeout: float = 300.0, poll: float = 0.5) -> models.RunResultOut:
        """Wait until the run succeeded and return its result; raises :class:`NodestroRunFailed` otherwise."""
        found = self.wait(run_id, timeout=timeout, poll=poll, stop_at_approval=False)
        if found.get("status") != "succeeded":
            raise NodestroRunFailed(cast(dict[str, Any], found))
        return self.result(run_id)

    def events(
        self, run_id: str, *, text: bool = False, last_event_id: str | None = None, timeout: float | None = None
    ) -> Generator[Event, None, None]:
        """Live events of a run: ``status``, the steps (``node_started`` ...), finally ``end``.

        ``text`` adds the agents' text as it is written. Not reconnected automatically: after a
        lost connection pass the ``id`` of the last event received as ``last_event_id`` to get what
        was missed. ``timeout`` limits the wait for the next line in seconds.
        """
        query = "?text=true" if text else ""
        headers = {"Last-Event-ID": last_event_id} if last_event_id else None
        return self._http.events(
            f"{self._base}/runs/{path_segment(run_id)}/events{query}", headers=headers, timeout=timeout
        )

    def cancel(self, run_id: str) -> models.RunStatusOut:
        return cast(models.RunStatusOut, self._http.json("POST", f"{self._base}/runs/{path_segment(run_id)}/cancel"))

    def approvals(self, run_id: str) -> list[models.ApprovalOut]:
        return cast(
            list[models.ApprovalOut], self._http.json("GET", f"{self._base}/runs/{path_segment(run_id)}/approvals")
        )

    def approve(
        self,
        run_id: str,
        decision: Literal["approved", "rejected"] = "approved",
        *,
        comment: str = "",
        approval_id: str | None = None,
    ) -> models.RunStatusOut:
        """Decide the waiting approval (``approval_id`` chooses one when several wait)."""
        body: dict[str, Any] = {"decision": decision, "comment": comment}
        if approval_id is not None:
            body["approval_id"] = approval_id
        return cast(
            models.RunStatusOut,
            self._http.json("POST", f"{self._base}/runs/{path_segment(run_id)}/approve", json_body=body),
        )

    def resume(self, run_id: str, *, restart: bool = False, confirm_side_effects: bool = False) -> models.RunStatusOut:
        """Continue a failed or cancelled run (or ``restart`` it) as a new run."""
        body: models.ResumeIn = {"restart": restart, "confirm_side_effects": confirm_side_effects}
        return cast(
            models.RunStatusOut,
            self._http.json("POST", f"{self._base}/runs/{path_segment(run_id)}/resume", json_body=body),
        )

    def files(self, run_id: str) -> list[dict[str, Any]]:
        """The result files of a run (``id``, ``name``, ``media_type`` ...; needs ``read``)."""
        return cast(list[dict[str, Any]], self._http.json("GET", f"{self._base}/runs/{path_segment(run_id)}/files"))

    def download(self, run_id: str, file_id: str) -> bytes:
        """The content of a result file (held in memory as a whole)."""
        return self._http.request(
            "GET", f"{self._base}/runs/{path_segment(run_id)}/files/{path_segment(file_id)}"
        ).content

    def usage(self, *, days: int = 30) -> models.UsageSummaryOut:
        """Runs, tokens and cost of this API over the last ``days`` (1 to 365)."""
        return cast(models.UsageSummaryOut, self._http.json("GET", f"{self._base}/usage", params={"days": days}))
