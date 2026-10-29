"""The client of a published workflow API (``/api/published/{slug}``), authenticated with a Nodestro key.

The same API is served by Nodestro itself (local or, when enabled, in the network) and by a
workflow exported as a standalone FastAPI project, so this client works with both.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
import time
from typing import Any, Literal, cast
import uuid

import httpx

from . import models
from ._http import Event, RetryPolicy, Transport
from .errors import NodestroRunFailed, NodestroTimeoutError

PREFIX = "/api/published"
#: API states that end a run; ``awaiting_approval`` waits for a person.
FINISHED = frozenset({"succeeded", "failed", "cancelled"})
WAITING = "awaiting_approval"


class PublishedWorkflow:
    """One published workflow: start runs, follow them, decide approvals, read results and files.

    >>> with PublishedWorkflow("http://127.0.0.1:8000", "angebot", api_key="ndk_...") as api:
    ...     run = api.start({"customer": "ACME"})
    ...     result = api.wait_for_result(run["run_id"])
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
        self.slug = slug
        self._base = f"{PREFIX}/{slug}"
        self._http = Transport(
            base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout, retry=retry, client=http_client
        )

    def close(self) -> None:
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
        """Start a run with the values of the workflow's input form.

        Every start carries an ``Idempotency-Key`` (a new one unless given), so a retry after a lost
        answer never starts a second run. ``wait`` waits up to that many seconds for the result
        (only when the publication allows synchronous calls).
        """
        path = f"{self._base}/versions/{version}/runs" if version is not None else f"{self._base}/runs"
        key = idempotency_key or uuid.uuid4().hex
        return cast(
            models.RunStatusOut,
            self._http.json(
                "POST",
                path,
                json_body=dict(values),
                params={"wait": wait},
                headers={"Idempotency-Key": key},
                retry_unsafe=True,
            ),
        )

    def runs(self, *, status: str | None = None, limit: int | None = None) -> list[models.RunStatusOut]:
        return cast(
            list[models.RunStatusOut],
            self._http.json("GET", f"{self._base}/runs", params={"status": status, "limit": limit}),
        )

    def status(self, run_id: str) -> models.RunStatusOut:
        return cast(models.RunStatusOut, self._http.json("GET", f"{self._base}/runs/{run_id}"))

    def result(self, run_id: str) -> models.RunResultOut:
        return cast(models.RunResultOut, self._http.json("GET", f"{self._base}/runs/{run_id}/result"))

    def wait(
        self, run_id: str, *, timeout: float = 300.0, poll: float = 0.5, stop_at_approval: bool = True
    ) -> models.RunStatusOut:
        """The status once the run finished (or waits for an approval, unless ``stop_at_approval`` is off)."""
        deadline = time.monotonic() + timeout
        while True:
            found = self.status(run_id)
            state = found.get("status")
            if state in FINISHED or (stop_at_approval and state == WAITING):
                return found
            if time.monotonic() >= deadline:
                raise NodestroTimeoutError(f"Run {run_id} is still {state} after {timeout:g} s")
            time.sleep(poll)

    def wait_for_result(self, run_id: str, *, timeout: float = 300.0, poll: float = 0.5) -> models.RunResultOut:
        """Wait until the run succeeded and return its result; raises :class:`NodestroRunFailed` otherwise."""
        found = self.wait(run_id, timeout=timeout, poll=poll, stop_at_approval=False)
        if found.get("status") != "succeeded":
            raise NodestroRunFailed(cast(dict[str, Any], found))
        return self.result(run_id)

    def events(self, run_id: str, *, text: bool = False, last_event_id: str | None = None) -> Iterator[Event]:
        """Live events of a run; after a lost connection pass the last ``Event.id`` to get what was missed."""
        query = "?text=true" if text else ""
        headers = {"Last-Event-ID": last_event_id} if last_event_id else None
        return self._http.events(f"{self._base}/runs/{run_id}/events{query}", headers=headers)

    def cancel(self, run_id: str) -> models.RunStatusOut:
        return cast(models.RunStatusOut, self._http.json("POST", f"{self._base}/runs/{run_id}/cancel"))

    def approvals(self, run_id: str) -> list[models.ApprovalOut]:
        return cast(list[models.ApprovalOut], self._http.json("GET", f"{self._base}/runs/{run_id}/approvals"))

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
        return cast(models.RunStatusOut, self._http.json("POST", f"{self._base}/runs/{run_id}/approve", json_body=body))

    def resume(self, run_id: str, *, restart: bool = False, confirm_side_effects: bool = False) -> models.RunStatusOut:
        """Continue a failed or cancelled run (or ``restart`` it) as a new run."""
        body: models.ResumeIn = {"restart": restart, "confirm_side_effects": confirm_side_effects}
        return cast(models.RunStatusOut, self._http.json("POST", f"{self._base}/runs/{run_id}/resume", json_body=body))

    def files(self, run_id: str) -> list[dict[str, Any]]:
        return cast(list[dict[str, Any]], self._http.json("GET", f"{self._base}/runs/{run_id}/files"))

    def download(self, run_id: str, file_id: str) -> bytes:
        return self._http.request("GET", f"{self._base}/runs/{run_id}/files/{file_id}").content

    def usage(self, *, days: int = 30) -> models.UsageSummaryOut:
        return cast(models.UsageSummaryOut, self._http.json("GET", f"{self._base}/usage", params={"days": days}))
