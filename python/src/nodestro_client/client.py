"""The client of the Nodestro API (the studio REST API under ``/api``).

The studio API is the one the Nodestro interface uses; it is local and has no keys of its own
(Nodestro listens on ``127.0.0.1`` by default). Published workflows have their own key-protected
API: :class:`~nodestro_client.published.PublishedWorkflow`.
"""

from __future__ import annotations

from collections.abc import Generator, Mapping, Sequence
import contextlib
from dataclasses import dataclass
from decimal import Decimal
import os
import threading
import time
from typing import IO, Any, Literal, cast
import uuid

import httpx

from . import models
from ._http import (
    API_VERSION,
    DOWNLOAD_CHUNK,
    Event,
    RetryPolicy,
    Transport,
    path_segment,
    poll_until,
    reconnect_policy,
    save_chunks,
)
from .errors import NodestroRunFailed


@dataclass(frozen=True)
class Compatibility:
    """The answer of :meth:`NodestroClient.check_compatibility`."""

    #: Whether this SDK fits the installation's API.
    compatible: bool
    #: The installation's API version and the one this SDK's types were generated from (``API_VERSION``).
    api_version: str
    sdk_api_version: str
    #: Why not, in English (empty when compatible).
    reason: str = ""


def _parts(version: str) -> tuple[int, int] | None:
    pieces = version.strip().split(".")
    if len(pieces) < 2 or not all(piece.isdigit() for piece in pieces[:2]):
        return None
    return int(pieces[0]), int(pieces[1])


def compatibility(api_version: str, sdk_api_version: str = API_VERSION) -> Compatibility:
    """Whether an API of ``api_version`` fits an SDK generated from ``sdk_api_version`` (see
    :meth:`NodestroClient.check_compatibility`)."""
    found, expected = _parts(api_version), _parts(sdk_api_version)

    def answer(reason: str = "") -> Compatibility:
        return Compatibility(not reason, api_version, sdk_api_version, reason)

    if found is None or expected is None:
        return answer(f"The API version {api_version!r} cannot be read")
    if found[0] != expected[0]:
        return answer(f"The API has major version {found[0]}, this SDK was made for {expected[0]}")
    if expected[0] == 0 and found[1] != expected[1]:
        return answer(f"The API is {api_version}; this SDK was made for {sdk_api_version} (0.x minors may break)")
    if found[1] < expected[1]:
        return answer(f"The API is {api_version}, older than the {sdk_api_version} this SDK was made for")
    return answer()


@dataclass(frozen=True)
class RunPage:
    """One page of :meth:`NodestroClient.list_runs_page`: the runs, newest first, and the ``before`` cursor of the
    next (older) page (``None``: no older run matches)."""

    runs: list[models.RunSummary]
    next_before: str | None = None


#: Run states that end a run, and the state of a run waiting for a person.
FINISHED = frozenset({"succeeded", "failed", "cancelled"})
WAITING = "paused"


class NodestroClient:
    """Workflows, runs, approvals, agents, tools and examples of a Nodestro installation.

    >>> with NodestroClient("http://127.0.0.1:8000") as nodestro:
    ...     run = nodestro.start_run(workflow_id, input="Topic X")
    ...     done = nodestro.wait_for_run(run["id"])

    ``base_url`` is the address of the installation (``http`` or ``https``, host, optional port and
    path prefix; no query). ``timeout`` limits each phase of a request (connect, write, each read)
    in seconds; ``retry`` repeats reads after connection errors and 502/503/504, never a request
    that changes something (except run starts, run chat messages and budget decisions: they carry a key).
    ``headers`` are sent with every request. An ``http_client`` passed in is used as is (its proxies, certificates
    and limits) and is not closed by :meth:`close`.

    Raises ``ValueError`` for an invalid base URL, timeout or id (``""``, ``.``, ``..``);
    every other error is a :class:`~nodestro_client.NodestroClientError`.
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8000",
        *,
        timeout: float = 30.0,
        retry: RetryPolicy | None = None,
        headers: Mapping[str, str] | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._http = Transport(base_url, headers=headers, timeout=timeout, retry=retry, client=http_client)

    def close(self) -> None:
        """Close the connections (only those of the client created here; safe to call twice)."""
        self._http.close()

    def __enter__(self) -> NodestroClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- installation ------------------------------------------------------------

    def meta(self) -> models.Meta:
        """Version, providers, models and server tools of the installation."""
        return cast(models.Meta, self._http.json("GET", "/api/meta"))

    def check_compatibility(self) -> Compatibility:
        """Compare the installation's API version (``/api/meta``) with the one this SDK was generated from.

        Never raises for a mismatch (only for a failed request): the answer says whether the versions fit and why
        not. They fit when the major versions are equal and, for ``0.x``, the minor versions too (``0.x`` minors
        may break); from ``1.0`` an API with a newer minor version fits as well."""
        found = str(self.meta().get("version", ""))
        return compatibility(found, API_VERSION)

    def settings(self) -> models.Settings:
        """The settings as the interface shows them (API keys are never returned)."""
        return cast(models.Settings, self._http.json("GET", "/api/settings"))

    def update_settings(self, changes: models.SettingsIn | Mapping[str, Any]) -> models.Settings:
        """Change some settings (needs ``admin``): only the fields given change, e.g.
        ``update_settings({"default_model": "anthropic:claude-sonnet-4-5"})``. Returns the settings afterwards
        (keys are never returned)."""
        return cast(models.Settings, self._http.json("PUT", "/api/settings", json_body=dict(changes)))

    def sandbox_status(self, *, refresh: bool = False, wait: float = 0.0) -> models.SandboxStatus:
        """The Docker sandbox of the computer the API runs on, as its background check last found it (``state``
        ``checking``, ``approved`` or ``unavailable``, with ``reason`` and ``checks``). Never waits for Docker;
        ``refresh`` starts a new check (answering at once), ``wait`` (seconds, at most 5) waits for a running one."""
        params: dict[str, Any] = {"refresh": "true" if refresh else "false", "wait": wait}
        return cast(models.SandboxStatus, self._http.json("GET", "/api/sandbox/status", params=params))

    def sandbox_self_test(self, *, timeout: float = 30.0) -> models.SandboxStatus:
        """Run the Docker sandbox's checks again now, the in-container self-test included (permission ``admin``),
        and wait at most ``timeout`` seconds (at most 60) for the result; ``state`` is ``checking`` while it goes
        on (see :meth:`sandbox_status`)."""
        return cast(
            models.SandboxStatus,
            self._http.json(
                "POST", "/api/sandbox/self-test", params={"timeout": timeout}, timeout=max(30.0, timeout + 15.0)
            ),
        )

    # ---- usage and model prices --------------------------------------------------

    def usage(self, *, days: int = 30) -> models.UsageReport:
        """Tokens and costs of the last ``days`` days; ``cost_state`` tells known, partial and unknown costs apart."""
        return cast(models.UsageReport, self._http.json("GET", "/api/usage", params={"days": days}))

    def list_prices(self) -> list[models.PriceEntry]:
        """Every effective model price with status, quality, source, check date and version."""
        return cast(list[models.PriceEntry], self._http.json("GET", "/api/pricing"))

    def pricing_status(self) -> models.PricingOverview:
        """The active price version, the last check, staleness and open reviews."""
        return cast(models.PricingOverview, self._http.json("GET", "/api/pricing/status"))

    def pricing_history(self, *, limit: int = 200) -> list[models.PricingEvent]:
        return cast(list[models.PricingEvent], self._http.json("GET", "/api/pricing/history", params={"limit": limit}))

    def sync_prices(self) -> models.SyncReport:
        """Check the prices against their sources now (desktop; a server answers 403)."""
        return cast(models.SyncReport, self._http.json("POST", "/api/pricing/sync"))

    def list_price_reviews(self) -> list[models.ReviewOut]:
        return cast(list[models.ReviewOut], self._http.json("GET", "/api/pricing/reviews"))

    def decide_price_review(
        self, version: str, decision: Literal["approve", "reject"], *, note: str | None = None
    ) -> models.SubmitResult | None:
        """Accept or discard the held-back price changes of a review (``None`` after a rejection)."""
        path = f"/api/pricing/reviews/{path_segment(version)}/{decision}"
        body: models.ReviewDecision = {"note": note}
        if decision == "reject":
            self._http.request("POST", path, json_body=body)
            return None
        return cast(models.SubmitResult, self._http.json("POST", path, json_body=body))

    def set_price_override(
        self, provider: str, model: str, price: models.OverrideIn | Mapping[str, Any]
    ) -> models.PriceEntry:
        """An individual price (USD per million tokens) for one model; it wins over the reference price."""
        return cast(
            models.PriceEntry,
            self._http.json(
                "PUT", f"/api/pricing/overrides/{path_segment(provider)}/{_model_path(model)}", json_body=dict(price)
            ),
        )

    def remove_price_override(self, provider: str, model: str) -> None:
        self._http.request("DELETE", f"/api/pricing/overrides/{path_segment(provider)}/{_model_path(model)}")

    def reconcile_costs(self, request: models.ReconciliationIn | Mapping[str, Any]) -> models.ReconciliationReport:
        """Compare Nodestro's estimates with the providers' bills (``start``, ``end``; optional one-off ``keys``)."""
        return cast(
            models.ReconciliationReport,
            self._http.json("POST", "/api/pricing/reconciliation", json_body=dict(request)),
        )

    # ---- workflows ---------------------------------------------------------------

    def list_workflows(self) -> list[models.WorkflowSummary]:
        return cast(list[models.WorkflowSummary], self._http.json("GET", "/api/workflows"))

    def get_workflow(self, workflow_id: str) -> models.Workflow:
        return cast(models.Workflow, self._http.json("GET", f"/api/workflows/{path_segment(workflow_id)}"))

    def create_workflow(self, workflow: models.WorkflowIn | Mapping[str, Any]) -> models.Workflow:
        return cast(models.Workflow, self._http.json("POST", "/api/workflows", json_body=dict(workflow)))

    def update_workflow(
        self,
        workflow_id: str,
        workflow: models.WorkflowIn | Mapping[str, Any],
        *,
        revision: str | None = None,
        note: str | None = None,
    ) -> models.Workflow:
        """Save a workflow; a changed one becomes its next version (``note`` describes it).

        ``revision`` is the workflow's ``updated_at`` as read (``get_workflow(id)["updated_at"]``): it is sent as
        ``If-Match``, so the save applies only when nobody saved in between, and is otherwise refused with
        :class:`NodestroAPIError` 409 ``workflow.conflict`` (``params["updated_at"]`` names the current revision).
        Without it the save always applies."""
        headers = {"If-Match": f'"{revision}"'} if revision is not None else None
        return cast(
            models.Workflow,
            self._http.json(
                "PUT",
                f"/api/workflows/{path_segment(workflow_id)}",
                json_body=dict(workflow),
                params={"note": note},
                headers=headers,
            ),
        )

    def delete_workflow(self, workflow_id: str) -> None:
        self._http.request("DELETE", f"/api/workflows/{path_segment(workflow_id)}")

    def check_workflow(
        self, workflow: models.WorkflowIn | Mapping[str, Any], workflow_id: str | None = None
    ) -> models.WorkflowCheck:
        """The pre-check of a run: problems per workflow and per agent (free, no model request).

        ``workflow`` is the workflow document; for a saved one pass ``check_workflow(client.get_workflow(id), id)``.
        """
        if isinstance(workflow, str):
            raise TypeError(
                "check_workflow() takes the workflow document, not its id: "
                "check_workflow(client.get_workflow(workflow_id), workflow_id)"
            )
        return cast(
            models.WorkflowCheck,
            self._http.json(
                "POST", "/api/workflows/check", json_body=dict(workflow), params={"workflow_id": workflow_id}
            ),
        )

    def workflow_versions(self, workflow_id: str) -> list[models.VersionSummary]:
        """The saved versions of a workflow, newest first."""
        return cast(
            list[models.VersionSummary],
            self._http.json("GET", f"/api/workflows/{path_segment(workflow_id)}/versions"),
        )

    # ---- runs ------------------------------------------------------------------------

    def start_run(
        self,
        workflow_id: str,
        *,
        input: str = "",
        values: Mapping[str, Any] | None = None,
        file_ids: Sequence[str] = (),
        idempotency_key: str | None = None,
    ) -> models.Run:
        """Start a run; it runs in the background (see :meth:`wait_for_run` and :meth:`events`).

        Every start carries an ``Idempotency-Key`` (a new random one unless given), so the automatic retry after a
        lost answer or a 502/503/504 returns the run that already started instead of starting a second one. Pass
        your own key (at most 200 characters) to make your own retries safe too; the same key with a different
        request is refused (409 ``idempotency.conflict``)."""
        body: models.RunIn = {"input": input, "values": dict(values or {}), "file_ids": list(file_ids)}
        return cast(
            models.Run,
            self._http.json(
                "POST",
                f"/api/workflows/{path_segment(workflow_id)}/runs",
                json_body=body,
                headers={"Idempotency-Key": idempotency_key or uuid.uuid4().hex},
                retry_unsafe=True,
            ),
        )

    def get_run(self, run_id: str) -> models.Run:
        return cast(models.Run, self._http.json("GET", f"/api/runs/{path_segment(run_id)}"))

    def list_runs(
        self, *, workflow_id: str | None = None, limit: int | None = None, before: str | None = None
    ) -> list[models.RunSummary]:
        """One page of stored runs, newest first (at most ``limit``, the API's default 100). ``before`` continues
        with older runs: a cursor from :meth:`list_runs_page` or a time (ISO 8601). :meth:`iter_runs` pages
        through all of them."""
        return self.list_runs_page(workflow_id=workflow_id, limit=limit, before=before).runs

    def list_runs_page(
        self, *, workflow_id: str | None = None, limit: int | None = None, before: str | None = None
    ) -> RunPage:
        """Like :meth:`list_runs`, with the cursor of the next (older) page (``None`` when no older run matches)."""
        response = self._http.request(
            "GET", "/api/runs", params={"workflow_id": workflow_id, "limit": limit, "before": before}
        )
        more = response.headers.get("x-has-more") == "true"
        cursor = response.headers.get("x-next-before") if more else None
        return RunPage(runs=cast(list[models.RunSummary], response.json()), next_before=cursor or None)

    def iter_runs(
        self, *, workflow_id: str | None = None, page_size: int = 100, before: str | None = None
    ) -> Generator[models.RunSummary, None, None]:
        """Every stored run (of one workflow), newest first, read a page of ``page_size`` (1 to 500) at a time with
        the API's cursor, so runs started meanwhile never shift a page."""
        cursor = before
        while True:
            page = self.list_runs_page(workflow_id=workflow_id, limit=page_size, before=cursor)
            yield from page.runs
            if page.next_before is None or not page.runs:
                return
            cursor = page.next_before

    def cancel_run(self, run_id: str) -> bool:
        """Ask a running run to stop; ``False`` when it had already ended."""
        return bool((self._http.json("POST", f"/api/runs/{path_segment(run_id)}/cancel") or {}).get("cancelled"))

    def wait_for_run(
        self,
        run_id: str,
        *,
        timeout: float = 300.0,
        poll: float = 0.5,
        stop_at_approval: bool = True,
        raise_on_failure: bool = False,
    ) -> models.Run:
        """Wait until the run finished (or waits for a person, unless ``stop_at_approval`` is off).

        A run that waits for a person is ``paused``, for example at an approval step or for a budget decision. A
        budget wait has ``run["budget"]["pending_request_id"]`` set; answer it with
        :meth:`raise_run_budget` or :meth:`end_run_for_budget` (see :meth:`get_run_budget`).

        Polls the run every ``poll`` seconds. ``timeout`` is the total wait in seconds: each status request
        gets the time that is left as its limit (at least half a second; a retry after a lost connection may add
        its pause). Raises
        :class:`NodestroTimeoutError` when the run has not ended by then (the run keeps running),
        and :class:`NodestroRunFailed` for a failed or cancelled run if ``raise_on_failure``.
        """
        path = f"/api/runs/{path_segment(run_id)}"
        run = poll_until(
            lambda left: cast(models.Run, self._http.json("GET", path, timeout=min(left, self._http.timeout))),
            lambda found: found.get("status") in FINISHED or (stop_at_approval and found.get("status") == WAITING),
            run_id=run_id,
            timeout=timeout,
            poll=poll,
        )
        if raise_on_failure and run.get("status") in ("failed", "cancelled"):
            raise NodestroRunFailed(cast(dict[str, Any], run))
        return run

    def events(
        self,
        run_id: str,
        *,
        timeout: float | None = None,
        reconnect: bool | RetryPolicy = False,
        stop: threading.Event | None = None,
    ) -> Generator[Event, None, None]:
        """The live events of a run: ``snapshot`` (the run), ``event`` (one step), ``end``.

        The connection stays open until the run ends. Leaving the loop early closes it when the
        generator is collected; ``with contextlib.closing(nodestro.events(run_id)) as events:``
        closes it at once. ``timeout`` limits the wait for the next line in seconds.

        ``reconnect`` (``True`` or a :class:`RetryPolicy`) connects again after a lost connection
        or a stall, with growing pauses, until ``end``. This stream has no event ids: every
        connection starts with a new ``snapshot`` (the whole run as it is now), and the steps
        between the lost connection and that snapshot are not delivered one by one. ``stop`` (a
        :class:`threading.Event`) ends the iteration, also during the pause before a reconnect.
        """
        return self._http.events(
            f"/api/runs/{path_segment(run_id)}/events",
            timeout=timeout,
            reconnect=reconnect_policy(reconnect),
            stop=stop,
        )

    def run_files(self, run_id: str) -> list[models.ResultFile]:
        """The result files of a run (documents written by its output steps)."""
        return cast(list[models.ResultFile], self._http.json("GET", f"/api/runs/{path_segment(run_id)}/files"))

    def download_file(self, run_id: str, file_id: str) -> bytes:
        """The content of a result file (held in memory as a whole; see :meth:`stream_file` for large files)."""
        return self._http.request("GET", f"/api/runs/{path_segment(run_id)}/files/{path_segment(file_id)}").content

    def stream_file(
        self, run_id: str, file_id: str, *, chunk_size: int = DOWNLOAD_CHUNK
    ) -> Generator[bytes, None, None]:
        """The content of a result file in chunks, never held in memory as a whole.

        The request is sent at the first ``next()``. A download that breaks off raises
        :class:`NodestroConnectionError` (or :class:`NodestroTimeoutError` after a stall of the
        client's ``timeout``). Leaving the loop early closes the connection when the generator is
        collected; ``contextlib.closing(...)`` closes it at once.
        """
        return self._http.download(
            f"/api/runs/{path_segment(run_id)}/files/{path_segment(file_id)}", chunk_size=chunk_size
        )

    def save_file(self, run_id: str, file_id: str, target: str | os.PathLike[str] | IO[bytes]) -> int:
        """Stream a result file to ``target`` (a path or a binary file object); returns the bytes written.

        A path is replaced only when the whole file arrived (a broken download leaves no partial
        file); a file object holds what arrived before an error.
        """
        with contextlib.closing(self.stream_file(run_id, file_id)) as chunks:
            return save_chunks(chunks, target)

    # ---- people in the loop and continued runs -------------------------------------------

    def list_approvals(self) -> list[models.PendingApproval]:
        """Every approval that waits for a decision (all runs)."""
        return cast(list[models.PendingApproval], self._http.json("GET", "/api/approvals"))

    def decide_approval(
        self, run_id: str, node_id: str, decision: Literal["approved", "rejected"], comment: str = ""
    ) -> models.Run:
        body: models.ApprovalDecision = {"decision": decision, "comment": comment}
        return cast(
            models.Run,
            self._http.json(
                "POST", f"/api/runs/{path_segment(run_id)}/approvals/{path_segment(node_id)}", json_body=body
            ),
        )

    def resume_plan(self, run_id: str) -> models.ResumePlan:
        """Which steps of a failed run would be reused or run again (nothing starts)."""
        return cast(models.ResumePlan, self._http.json("GET", f"/api/runs/{path_segment(run_id)}/resume"))

    def resume_run(
        self, run_id: str, *, mode: Literal["continue", "restart"] = "continue", confirm: bool = False
    ) -> models.Run:
        body: models.ResumeRequest = {"mode": mode, "confirm_side_effects": confirm}
        return cast(models.Run, self._http.json("POST", f"/api/runs/{path_segment(run_id)}/resume", json_body=body))

    # ---- run budgets ---------------------------------------------------------------------------

    def get_run_budget(self, run_id: str) -> models.RunBudgetOut:
        """The budget of a run: limits, spending, raises, the open request (``pending``), earlier requests and what
        the caller may decide (``policy``). ``run_id`` may be a run below the top-level run; the answer is the top-level
        run's budget. Amounts are decimal strings (``"2.50"``)."""
        return cast(models.RunBudgetOut, self._http.json("GET", f"/api/runs/{path_segment(run_id)}/budget"))

    def list_budget_requests(self) -> list[models.BudgetRequest]:
        """Every budget request that waits for a decision (all runs), oldest first."""
        return cast(
            list[models.BudgetRequest], self._http.json("GET", "/api/budget-requests", params={"status": "pending"})
        )

    def decide_run_budget(
        self,
        run_id: str,
        request_id: str,
        action: Literal["raise", "end"],
        *,
        limit_usd: str | Decimal | None = None,
        idempotency_key: str | None = None,
    ) -> models.RunBudgetOut:
        """Answer a run's budget request: ``raise`` sets the blocking limit to ``limit_usd`` and continues the run
        (one operation), ``end`` ends the run. Returns the run's budget after the decision.

        ``limit_usd`` is a decimal string or :class:`~decimal.Decimal` with at most two decimal places (``"2.50"``);
        a float is refused with ``TypeError``, so no amount is rounded on the way. Every decision carries an
        ``idempotency_key`` (a new random one unless given), so the automatic retry after a lost answer or a
        502/503/504 returns the stored result instead of being refused as already decided. Pass your own key (at
        most 100 of ``A-Z a-z 0-9 . _ : -``) to make your own retries safe too.

        Refusals are :class:`~nodestro_client.NodestroAPIError`: 404 (run or request unknown), 409
        ``budget.not_pending`` (decided, expired or cancelled; ``params`` has ``request_status`` and ``decided_by``),
        422 ``budget.limit_not_higher`` (``params["current_limit_usd"]``) and ``budget.limit_invalid``, 403
        ``budget.over_policy`` (above ``params["max_limit_usd"]``) and ``access.forbidden`` (only the person who
        started the run or an administrator decides; ``params["reason"]``).
        """
        body: models.BudgetDecisionIn = {
            "request_id": request_id,
            "action": action,
            "idempotency_key": idempotency_key or uuid.uuid4().hex,
        }
        if limit_usd is not None:
            body["limit_usd"] = _amount(limit_usd)
        return cast(
            models.RunBudgetOut,
            self._http.json(
                "POST", f"/api/runs/{path_segment(run_id)}/budget/decisions", json_body=body, retry_unsafe=True
            ),
        )

    def raise_run_budget(
        self, run_id: str, request_id: str, limit_usd: str | Decimal, *, idempotency_key: str | None = None
    ) -> models.RunBudgetOut:
        """Raise the limit that stopped the run to ``limit_usd`` and continue it (see :meth:`decide_run_budget`)."""
        amount = _amount(limit_usd)  # also refuses a missing limit before anything is sent
        return self.decide_run_budget(run_id, request_id, "raise", limit_usd=amount, idempotency_key=idempotency_key)

    def end_run_for_budget(
        self, run_id: str, request_id: str, *, idempotency_key: str | None = None
    ) -> models.RunBudgetOut:
        """End the run instead of raising its budget; it ends as ``cancelled`` with ``error_code``
        ``run.budget_ended`` (see :meth:`decide_run_budget`)."""
        return self.decide_run_budget(run_id, request_id, "end", idempotency_key=idempotency_key)

    # ---- live run chat ---------------------------------------------------------------------

    def run_chat(self, run_id: str) -> models.RunChatView:
        """The live chat of a run: messages, the orchestrators one can talk to (with what their teams do now)
        and the limits. ``run_id`` may be the top-level run or any run below it; the chat belongs to the top."""
        return cast(models.RunChatView, self._http.json("GET", f"/api/runs/{path_segment(run_id)}/chat"))

    def send_run_chat_message(
        self,
        run_id: str,
        *,
        kind: Literal["question", "instruction"],
        target_run_id: str,
        node_id: str,
        content: str,
        client_id: str | None = None,
    ) -> models.RunMessage:
        """Ask a question about the run (answered from the stored run state; it changes nothing) or give the
        orchestrator ``node_id`` of ``target_run_id`` an instruction for its next decision.

        Every message carries a ``client_id`` (a new random one unless given), so the automatic retry after a
        lost answer or a 502/503/504 returns the stored message instead of sending a second one. Pass your own
        key (at most 100 of ``A-Z a-z 0-9 . _ : -``) to make your own retries safe too; the same key for another
        message is refused (409 ``run_chat.client_id_reused``). The answer to a question arrives later as a
        message of kind ``answer`` (see :meth:`run_chat_events`).
        """
        body: models.ChatMessageIn = {
            "kind": kind,
            "target_run_id": target_run_id,
            "node_id": node_id,
            "content": content,
            "client_id": client_id or uuid.uuid4().hex,
        }
        return cast(
            models.RunMessage,
            self._http.json(
                "POST", f"/api/runs/{path_segment(run_id)}/chat/messages", json_body=body, retry_unsafe=True
            ),
        )

    def run_chat_message(self, run_id: str, message_id: str) -> models.RunMessage:
        """One message of the run's chat (e.g. to see whether a question was answered)."""
        return cast(
            models.RunMessage,
            self._http.json("GET", f"/api/runs/{path_segment(run_id)}/chat/messages/{path_segment(message_id)}"),
        )

    def run_chat_events(
        self,
        run_id: str,
        *,
        timeout: float | None = None,
        reconnect: bool | RetryPolicy = False,
        stop: threading.Event | None = None,
    ) -> Generator[Event, None, None]:
        """The live events of a run's chat: ``snapshot`` (the whole view, on every connect), ``message`` (a new
        or changed message), ``targets`` (what the orchestrators do now), ``end`` (the run ended and no answer is
        pending, or access ended).

        A reconnect gets a new snapshot. Leaving the loop early closes the connection when the generator is
        collected; ``with contextlib.closing(...)`` closes it at once. ``timeout`` limits the wait for the next
        line in seconds. ``reconnect`` and ``stop`` work as in :meth:`events`.
        """
        return self._http.events(
            f"/api/runs/{path_segment(run_id)}/chat/events",
            timeout=timeout,
            reconnect=reconnect_policy(reconnect),
            stop=stop,
        )

    # ---- agents, tools, examples ---------------------------------------------------------

    def validate_agent(self, agent: models.AgentConfig | Mapping[str, Any]) -> list[models.ConfigIssue]:
        """The problems of one agent configuration (empty when it is fine; no model request)."""
        return cast(list[models.ConfigIssue], self._http.json("POST", "/api/agents/validate", json_body=dict(agent)))

    def list_agent_templates(self) -> list[models.AgentTemplate]:
        return cast(list[models.AgentTemplate], self._http.json("GET", "/api/agents/templates"))

    def create_agent_template(self, template: models.AgentTemplateIn | Mapping[str, Any]) -> models.AgentTemplate:
        """Save an agent as a template (``{"agent": {...}}``)."""
        return cast(models.AgentTemplate, self._http.json("POST", "/api/agents/templates", json_body=dict(template)))

    def update_agent_template(
        self, template_id: str, template: models.AgentTemplateIn | Mapping[str, Any]
    ) -> models.AgentTemplate:
        return cast(
            models.AgentTemplate,
            self._http.json("PUT", f"/api/agents/templates/{path_segment(template_id)}", json_body=dict(template)),
        )

    def delete_agent_template(self, template_id: str) -> None:
        self._http.request("DELETE", f"/api/agents/templates/{path_segment(template_id)}")

    def list_tools(self) -> list[models.ToolInfo]:
        """The tools agents can use: built-in, custom and generated ones."""
        return cast(list[models.ToolInfo], self._http.json("GET", "/api/tools"))

    # ---- connected MCP services ------------------------------------------------------------

    def mcp_status(self) -> models.McpStatus:
        """Whether MCP is available here: token vault, operator endpoint list, loopback, unattended runs, write gate."""
        return cast(models.McpStatus, self._http.json("GET", "/api/mcp/status"))

    def list_mcp_servers(self) -> list[models.McpServerView]:
        """The connected MCP servers (tokens are never returned, only ``token_set`` and ``token_storage``)."""
        return cast(list[models.McpServerView], self._http.json("GET", "/api/mcp/servers"))

    def add_mcp_server(self, server: models.McpServerIn | Mapping[str, Any]) -> models.McpServerView:
        """Connect an MCP server (``name``, ``url``, optional ``auth`` and write-only ``token``); needs ``admin``."""
        return cast(models.McpServerView, self._http.json("POST", "/api/mcp/servers", json_body=dict(server)))

    def update_mcp_server(self, server_id: str, server: models.McpServerIn | Mapping[str, Any]) -> models.McpServerView:
        """Change a server; an omitted ``token`` keeps the stored one, ``""`` removes it."""
        return cast(
            models.McpServerView,
            self._http.json("PUT", f"/api/mcp/servers/{path_segment(server_id)}", json_body=dict(server)),
        )

    def remove_mcp_server(self, server_id: str) -> None:
        self._http.request("DELETE", f"/api/mcp/servers/{path_segment(server_id)}")

    def discover_mcp_tools(self, server_id: str) -> models.McpDiscovery:
        """Connect to the server and list its tools; new and changed definitions wait for an administrator."""
        return cast(
            models.McpDiscovery, self._http.json("POST", f"/api/mcp/servers/{path_segment(server_id)}/discover")
        )

    def list_mcp_tools(self, server_id: str) -> list[models.McpToolView]:
        return cast(
            list[models.McpToolView], self._http.json("GET", f"/api/mcp/servers/{path_segment(server_id)}/tools")
        )

    def decide_mcp_tool(
        self,
        server_id: str,
        name: str,
        *,
        approve: bool,
        access: Literal["read", "write", "destructive"] | None = None,
        expected_hash: str | None = None,
    ) -> models.McpToolView:
        """Approve (with a classification) or reject a tool's current definition.

        ``expected_hash`` is the definition hash you reviewed: the server refuses when the definition changed since."""
        body: dict[str, Any] = {"approve": approve}
        if access is not None:
            body["access"] = access
        if expected_hash is not None:
            body["expected_hash"] = expected_hash
        path = f"/api/mcp/servers/{path_segment(server_id)}/tools/{path_segment(name)}/decision"
        return cast(models.McpToolView, self._http.json("POST", path, json_body=body))

    def start_mcp_sign_in(self, server_id: str) -> models.McpOAuthStart:
        """Start the OAuth sign-in of a server with ``auth="oauth"``; open ``authorization_url`` in a browser. The
        authorization server returns to Nodestro's callback, which stores the credentials sealed."""
        return cast(
            models.McpOAuthStart, self._http.json("POST", f"/api/mcp/servers/{path_segment(server_id)}/oauth/start")
        )

    def sign_out_mcp_server(self, server_id: str) -> models.McpServerView:
        """Forget a server's OAuth credentials."""
        return cast(
            models.McpServerView,
            self._http.json("POST", f"/api/mcp/servers/{path_segment(server_id)}/oauth/sign-out"),
        )

    def mcp_server_environment(self, server_id: str) -> models.DependencyStatus:
        """The package environment of a local (stdio) server: approval, installation and image state."""
        return cast(
            models.DependencyStatus,
            self._http.json("GET", f"/api/mcp/servers/{path_segment(server_id)}/environment"),
        )

    def plan_mcp_server_environment(self, server_id: str) -> models.Plan:
        """Resolve the hash-pinned package versions of a local server for review (approval goes through the
        ordinary package environment routes with scope ``mcp``)."""
        path = f"/api/mcp/servers/{path_segment(server_id)}/environment/plan"
        return cast(models.Plan, self._http.json("POST", path))

    def mcp_stats(self) -> models.McpStats:
        """Operational state for administrators: active calls, limits and each server's health (no secrets)."""
        return cast(models.McpStats, self._http.json("GET", "/api/mcp/stats"))

    def mcp_events(self, *, limit: int = 100) -> list[models.McpEvent]:
        """The audit log of the MCP configuration (never tokens or tool arguments)."""
        return cast(list[models.McpEvent], self._http.json("GET", "/api/mcp/events", params={"limit": limit}))

    # ---- batches (one workflow over many inputs) -------------------------------------------

    def list_batches(self) -> list[models.BatchSummary]:
        """The batches, newest first."""
        return cast(list[models.BatchSummary], self._http.json("GET", "/api/batches"))

    def get_batch(self, batch_id: str) -> models.Batch:
        """One batch with its items (one per row: status, run id, error)."""
        return cast(models.Batch, self._http.json("GET", f"/api/batches/{path_segment(batch_id)}"))

    def parse_batch_file(
        self, workflow_id: str, file: str | os.PathLike[str] | bytes | IO[bytes], *, filename: str | None = None
    ) -> models.ParsedRows:
        """The rows of a CSV, XLSX or JSON file (at most 10 MB, 1000 rows) and a suggested mapping of its columns
        to the workflow's form; nothing starts. ``file`` is a path, the content or a binary file object;
        ``filename`` (its extension tells the format) defaults to the path's name or ``rows.csv``."""
        name, content = _upload(file, filename, "rows.csv")
        return cast(
            models.ParsedRows,
            self._http.json(
                "POST", "/api/batches/parse", files={"file": (name, content)}, data={"workflow_id": workflow_id}
            ),
        )

    def plan_batch(self, batch: models.BatchIn | Mapping[str, Any]) -> models.BatchPlan:
        """Count the valid and invalid rows and estimate the cost; nothing starts."""
        return cast(models.BatchPlan, self._http.json("POST", "/api/batches/plan", json_body=dict(batch)))

    def create_batch(self, batch: models.BatchIn | Mapping[str, Any]) -> models.Batch:
        """Start a batch: ``{"workflow_id": ..., "rows": [{"values": {...}} or {"input": "..."}, ...]}`` with
        ``concurrency``, ``max_cost_usd``, ``max_failures``. A workflow with external tools needs
        ``confirm_external``. Not retried automatically (it would start the rows twice)."""
        return cast(models.Batch, self._http.json("POST", "/api/batches", json_body=dict(batch)))

    def pause_batch(self, batch_id: str) -> models.Batch:
        """Start no further rows (running ones finish)."""
        return cast(models.Batch, self._http.json("POST", f"/api/batches/{path_segment(batch_id)}/pause"))

    def resume_batch(self, batch_id: str) -> models.Batch:
        return cast(models.Batch, self._http.json("POST", f"/api/batches/{path_segment(batch_id)}/resume"))

    def cancel_batch(self, batch_id: str) -> models.Batch:
        """Cancel the batch and its running rows."""
        return cast(models.Batch, self._http.json("POST", f"/api/batches/{path_segment(batch_id)}/cancel"))

    def delete_batch(self, batch_id: str) -> None:
        self._http.request("DELETE", f"/api/batches/{path_segment(batch_id)}")

    def export_batch(self, batch_id: str, *, format: Literal["csv", "json"] = "csv") -> bytes:
        """The results of all rows as a CSV (default) or JSON file."""
        if format not in ("csv", "json"):
            raise ValueError(f"format must be 'csv' or 'json', not {format!r}")
        path = f"/api/batches/{path_segment(batch_id)}/export"
        return self._http.request("GET", path, params={"format": format}).content

    # ---- schedules (runs at set times) ----------------------------------------------------

    def list_schedules(self) -> list[models.Schedule]:
        return cast(list[models.Schedule], self._http.json("GET", "/api/schedules"))

    def get_schedule(self, schedule_id: str) -> models.Schedule:
        return cast(models.Schedule, self._http.json("GET", f"/api/schedules/{path_segment(schedule_id)}"))

    def schedule_time_zones(self) -> list[str]:
        """The IANA time zones a schedule can use."""
        return cast(list[str], self._http.json("GET", "/api/schedules/time-zones"))

    def preview_schedule(
        self, schedule: models.ScheduleIn | Mapping[str, Any], *, schedule_id: str | None = None
    ) -> models.Activation:
        """Whether the schedule could be enabled (``ok``, ``problems``, ``notes``) and its next run times;
        ``schedule_id`` checks a change of an existing schedule. Nothing is stored."""
        return cast(
            models.Activation,
            self._http.json(
                "POST", "/api/schedules/preview", json_body=dict(schedule), params={"schedule_id": schedule_id}
            ),
        )

    def create_schedule(self, schedule: models.ScheduleIn | Mapping[str, Any]) -> models.Schedule:
        """Store a schedule (``kind`` ``once``/``hourly``/``daily``/``weekly``/``monthly``, ``at``, ``time_zone``
        ...). It is created disabled: :meth:`enable_schedule` starts it."""
        return cast(models.Schedule, self._http.json("POST", "/api/schedules", json_body=dict(schedule)))

    def update_schedule(self, schedule_id: str, schedule: models.ScheduleIn | Mapping[str, Any]) -> models.Schedule:
        """Replace a schedule's settings (the whole ``ScheduleIn``)."""
        return cast(
            models.Schedule,
            self._http.json("PUT", f"/api/schedules/{path_segment(schedule_id)}", json_body=dict(schedule)),
        )

    def enable_schedule(self, schedule_id: str) -> models.ScheduleState:
        """Enable a schedule; refused (``activation.problems``) when its workflow cannot run unattended."""
        path = f"/api/schedules/{path_segment(schedule_id)}/enable"
        return cast(models.ScheduleState, self._http.json("POST", path))

    def disable_schedule(self, schedule_id: str) -> models.ScheduleState:
        path = f"/api/schedules/{path_segment(schedule_id)}/disable"
        return cast(models.ScheduleState, self._http.json("POST", path))

    def delete_schedule(self, schedule_id: str) -> None:
        self._http.request("DELETE", f"/api/schedules/{path_segment(schedule_id)}")

    # ---- local models (Ollama) and the semantic knowledge index ---------------------------

    def local_models(self) -> models.LocalOverview:
        """The local model server's state, the catalog with what is installed, this computer's hardware and a
        recommendation per task. A recommendation is a suggestion: store the chosen model explicitly."""
        return cast(models.LocalOverview, self._http.json("GET", "/api/local-models"))

    def recommend_local_model(self, task: str) -> models.Recommendation:
        """The local model for a task profile (``classify``, ``write``, ``analysis``, ``embedding`` ...)."""
        return cast(models.Recommendation, self._http.json("GET", "/api/local-models/recommend", params={"task": task}))

    def start_local_models(self) -> models.LocalStatus:
        """Start the managed local model server (desktop); a server's tenants get 403 ``local.server_managed``."""
        return cast(models.LocalStatus, self._http.json("POST", "/api/local-models/start"))

    def stop_local_models(self) -> models.LocalStatus:
        return cast(models.LocalStatus, self._http.json("POST", "/api/local-models/stop"))

    def install_local_runtime(self, *, archive: str | None = None, download: bool = False) -> models.LocalJob:
        """Install the pinned, SHA-256-verified Ollama runtime from a release archive on the Nodestro computer, or
        download it (refused in the strict offline mode). Follow the job with :meth:`local_model_job`."""
        body = {"archive": archive, "download": download}
        return cast(models.LocalJob, self._http.json("POST", "/api/local-models/runtime", json_body=body))

    def pull_local_model(self, model: str) -> models.LocalJob:
        """Download a model (e.g. ``qwen3.5:4b``); needs the internet."""
        return cast(models.LocalJob, self._http.json("POST", "/api/local-models/pull", json_body={"model": model}))

    def import_local_model(
        self,
        kind: Literal["package", "gguf", "build"],
        path: str,
        *,
        name: str | None = None,
        select: Sequence[str] | None = None,
        projector: str | None = None,
        template: str | None = None,
    ) -> models.LocalJob:
        """Import offline: an offline model package (checked by SHA-256; ``select`` picks some of its models), a GGUF
        file (``name`` the model to create, ``projector`` an optional vision projector), or ``build`` a catalog model
        that is built from files (``name`` the catalog model, e.g. ``mdenseon:307m``; ``path`` its upstream weights
        file and ``template`` the template GGUF file of its recipe, see ``build_inputs`` of :meth:`local_models`).
        Paths name files on the computer that runs Nodestro."""
        body: dict[str, Any] = {"kind": kind, "path": path, "name": name, "projector": projector}
        if template is not None:
            body["template"] = template
        if select is not None:
            body["models"] = list(select)
        return cast(models.LocalJob, self._http.json("POST", "/api/local-models/import", json_body=body))

    def delete_local_model(self, name: str) -> None:
        self._http.request("DELETE", f"/api/local-models/models/{path_segment(name)}")

    def local_model_job(self, job_id: str) -> models.LocalJob:
        """A job's progress (``completed`` of ``total``) and outcome."""
        return cast(models.LocalJob, self._http.json("GET", f"/api/local-models/jobs/{path_segment(job_id)}"))

    def cancel_local_model_job(self, job_id: str) -> models.LocalJob:
        path = f"/api/local-models/jobs/{path_segment(job_id)}/cancel"
        return cast(models.LocalJob, self._http.json("POST", path))

    def knowledge_index(self) -> models.KnowledgeIndexStatus:
        """The semantic knowledge index: retrieval mode, embedding model, state and how many chunks are embedded."""
        return cast(models.KnowledgeIndexStatus, self._http.json("GET", "/api/knowledge/index"))

    def rebuild_knowledge_index(self, model: str | None = None) -> models.KnowledgeIndexStatus:
        """Build or rebuild the semantic index (default: the embedding model of the settings). Searches keep the
        complete current index until the new one is finished; a cancelled rebuild continues where it stopped."""
        body = {"model": model}
        return cast(
            models.KnowledgeIndexStatus, self._http.json("POST", "/api/knowledge/index/rebuild", json_body=body)
        )

    def cancel_knowledge_index(self) -> models.KnowledgeIndexStatus:
        return cast(models.KnowledgeIndexStatus, self._http.json("POST", "/api/knowledge/index/cancel"))

    def list_examples(self, language: str | None = None) -> list[models.TemplateSummary]:
        """The example library (``language``: ``de``, ``en``, ``es``, ``fr``, ``it`` or ``pt-BR``)."""
        return cast(list[models.TemplateSummary], self._http.json("GET", "/api/library", params={"language": language}))

    def copy_example(self, template_id: str, *, language: str | None = None, tests: bool = False) -> models.Workflow:
        """Copy an example into a new workflow (``tests`` also copies its test cases)."""
        body: models.LibraryCopy = {"language": cast(Any, language), "tests": tests}
        return cast(
            models.Workflow, self._http.json("POST", f"/api/library/{path_segment(template_id)}/copy", json_body=body)
        )

    # ---- publishing ------------------------------------------------------------------------

    def publish(self, workflow_id: str, **options: Any) -> models.PublishOut:
        """Publish the workflow as an API.

        Options: ``slug``, ``note``, ``version``, ``activate``, ``gate`` (switch the release gate on with this
        release) and ``override`` (``{"reason": ...}``: release although non-critical gate items failed).
        """
        return cast(
            models.PublishOut,
            self._http.json("POST", f"/api/workflows/{path_segment(workflow_id)}/api/publish", json_body=options),
        )

    def release_gate(
        self, workflow_id: str, *, version: int | None = None, gate: models.ReleaseGate | None = None
    ) -> models.GateReport:
        """What the release gate says about a saved version (``gate``: try one before switching it on)."""
        body: dict[str, Any] = {"version": version, "gate": gate}
        return cast(
            models.GateReport,
            self._http.json("POST", f"/api/workflows/{path_segment(workflow_id)}/api/gate", json_body=body),
        )

    def update_publication(self, publication_id: str, patch: models.PublicationPatch) -> models.Publication:
        """Change a publication's slug, description, network access, limits or ``mcp_tool`` (offer the API as a tool
        of Nodestro's MCP server; it answers only when the operator switched the server on)."""
        return cast(
            models.Publication,
            self._http.json("PATCH", f"/api/publications/{path_segment(publication_id)}", json_body=dict(patch)),
        )

    def set_release_gate(self, publication_id: str, gate: models.ReleaseGate | None) -> models.Publication:
        """Switch the release gate of a publication on, change it, or switch it off (``None``)."""
        return cast(
            models.Publication,
            self._http.json("PUT", f"/api/publications/{path_segment(publication_id)}/gate", json_body={"gate": gate}),
        )

    def create_api_key(self, name: str, scopes: Sequence[str], publications: Sequence[str]) -> models.NewApiKey:
        """A key for published workflows; its ``token`` is returned only this once.

        ``scopes`` are ``run``, ``read`` and ``approve``; ``publications`` are publication ids.
        """
        body: models.KeyIn = {"name": name, "scopes": cast(Any, list(scopes)), "publications": list(publications)}
        return cast(models.NewApiKey, self._http.json("POST", "/api/api-keys", json_body=body))

    def list_api_keys(self) -> list[models.ApiKeyOut]:
        """Every key for published workflows (never its token: only a hash is stored)."""
        return cast(list[models.ApiKeyOut], self._http.json("GET", "/api/api-keys"))

    def revoke_api_key(self, key_id: str) -> models.ApiKeyOut:
        """Revoke a key at once; it stays listed as revoked."""
        return cast(models.ApiKeyOut, self._http.json("POST", f"/api/api-keys/{path_segment(key_id)}/revoke"))

    def rotate_api_key(self, key_id: str) -> models.NewApiKey:
        """A new key with the same name, permissions and publications; the old one is revoked in the same step. The
        new ``token`` is returned only this once."""
        return cast(models.NewApiKey, self._http.json("POST", f"/api/api-keys/{path_segment(key_id)}/rotate"))

    def delete_api_key(self, key_id: str) -> None:
        """Delete a key (revoked or not) from the list."""
        self._http.request("DELETE", f"/api/api-keys/{path_segment(key_id)}")

    def list_publications(self) -> list[models.Publication]:
        """Every published workflow API of the installation."""
        return cast(list[models.Publication], self._http.json("GET", "/api/publications"))

    def delete_publication(self, publication_id: str) -> None:
        """Take a workflow's API offline and delete its publication with its releases (keys lose it); refused with
        ``api.runs_active`` while runs of the API have not finished."""
        self._http.request("DELETE", f"/api/publications/{path_segment(publication_id)}")

    # ---- test series (a workflow against saved test cases) ----------------------------------

    def list_test_series(self) -> list[models.Suite]:
        """The test series (suites of test cases), most recently changed first."""
        return cast(list[models.Suite], self._http.json("GET", "/api/benchmarks"))

    def get_test_series(self, suite_id: str) -> models.Suite:
        return cast(models.Suite, self._http.json("GET", f"/api/benchmarks/{path_segment(suite_id)}"))

    def create_test_series(self, suite: models.SuiteIn | Mapping[str, Any]) -> models.Suite:
        """Save a test series: ``{"workflow_id": ..., "name": ..., "cases": [{"input": ..., "checks": [...]}]}``."""
        return cast(models.Suite, self._http.json("POST", "/api/benchmarks", json_body=dict(suite)))

    def update_test_series(self, suite_id: str, suite: models.SuiteIn | Mapping[str, Any]) -> models.Suite:
        path = f"/api/benchmarks/{path_segment(suite_id)}"
        return cast(models.Suite, self._http.json("PUT", path, json_body=dict(suite)))

    def delete_test_series(self, suite_id: str) -> None:
        self._http.request("DELETE", f"/api/benchmarks/{path_segment(suite_id)}")

    def plan_test_run(
        self, suite_id: str, start: models.BenchmarkStart | Mapping[str, Any] | None = None
    ) -> models.BenchmarkPlan:
        """What a test run would do and cost (cases, judged cases, estimate, problems); nothing starts."""
        path = f"/api/benchmarks/{path_segment(suite_id)}/plan"
        return cast(models.BenchmarkPlan, self._http.json("POST", path, json_body=dict(start or {})))

    def start_test_run(
        self, suite_id: str, start: models.BenchmarkStart | Mapping[str, Any] | None = None
    ) -> models.BenchmarkRun:
        """Run every case of a test series (``judge``, ``concurrency``, ``max_cost_usd``, ``max_failures``,
        ``version``, ``models``). Not retried automatically (it would run the cases twice)."""
        path = f"/api/benchmarks/{path_segment(suite_id)}/runs"
        return cast(models.BenchmarkRun, self._http.json("POST", path, json_body=dict(start or {})))

    def list_test_runs(self, suite_id: str) -> list[models.BenchmarkRun]:
        """The test runs of a series, newest first."""
        path = f"/api/benchmarks/{path_segment(suite_id)}/runs"
        return cast(list[models.BenchmarkRun], self._http.json("GET", path))

    def get_test_run(self, run_id: str) -> models.BenchmarkRun:
        return cast(models.BenchmarkRun, self._http.json("GET", f"/api/benchmark-runs/{path_segment(run_id)}"))

    def wait_for_test_run(self, run_id: str, *, timeout: float = 600.0, poll: float = 1.0) -> models.BenchmarkRun:
        """Poll a test run until it is no longer ``running`` or ``evaluating``; :class:`TimeoutError` after
        ``timeout`` seconds."""
        deadline = time.monotonic() + timeout
        while True:
            found = self.get_test_run(run_id)
            if found.get("status") not in ("running", "evaluating"):
                return found
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Test run {run_id} did not finish within {timeout} seconds")
            time.sleep(poll)

    def cancel_test_run(self, run_id: str) -> models.BenchmarkRun:
        path = f"/api/benchmark-runs/{path_segment(run_id)}/cancel"
        return cast(models.BenchmarkRun, self._http.json("POST", path))

    def delete_test_run(self, run_id: str) -> None:
        self._http.request("DELETE", f"/api/benchmark-runs/{path_segment(run_id)}")

    def compare_test_runs(self, a: str, b: str) -> models.Comparison:
        """Two test runs of a series case by case (for example two workflow versions)."""
        return cast(models.Comparison, self._http.json("GET", "/api/benchmark-runs/compare", params={"a": a, "b": b}))

    def test_series_model_choice(
        self,
        suite_id: str,
        node_id: str,
        *,
        objective: str = "cost",
        min_pass_rate: float | None = None,
        no_new_failures: bool = True,
    ) -> models.ModelChoice:
        """The model one agent should use by the series' measured test runs and a policy; nothing changes."""
        params: dict[str, Any] = {"node_id": node_id, "objective": objective, "no_new_failures": no_new_failures}
        if min_pass_rate is not None:
            params["min_pass_rate"] = min_pass_rate
        path = f"/api/benchmarks/{path_segment(suite_id)}/model-choice"
        return cast(models.ModelChoice, self._http.json("GET", path, params=params))

    def propose_test_case(
        self, run_id: str, request: models.CaseProposalIn | Mapping[str, Any] | None = None
    ) -> models.CaseProposal:
        """A redacted test case from the input of a failed run (credentials always replaced; ``personal_data``
        replaces e-mail addresses, phone numbers and the like too); nothing is stored."""
        path = f"/api/runs/{path_segment(run_id)}/test-case"
        return cast(models.CaseProposal, self._http.json("POST", path, json_body=dict(request or {})))

    # ---- knowledge files and search ----------------------------------------------------------

    def list_knowledge(self, query: str | None = None) -> list[models.KnowledgeFile]:
        """The knowledge files (``query`` filters by name and description)."""
        params = {"q": query} if query else None
        return cast(list[models.KnowledgeFile], self._http.json("GET", "/api/knowledge", params=params))

    def upload_knowledge(
        self,
        files: Sequence[str | os.PathLike[str] | tuple[str, bytes]],
        *,
        description: str = "",
        collection: str = "",
    ) -> list[models.KnowledgeFile]:
        """Add files to the knowledge base: paths, or ``(filename, content)`` pairs (the extension tells the
        format). Not retried automatically (it would add them twice)."""
        parts = [("files", _upload(item, None, "file")) for item in _uploads(files)]
        data = {"description": description, "collection": collection}
        return cast(list[models.KnowledgeFile], self._http.json("POST", "/api/knowledge", files=parts, data=data))

    def update_knowledge(
        self, file_id: str, *, description: str, collection: str | None = None
    ) -> models.KnowledgeFile:
        """Change a knowledge file's description and (when given) its collection."""
        body: dict[str, Any] = {"description": description}
        if collection is not None:
            body["collection"] = collection
        path = f"/api/knowledge/{path_segment(file_id)}"
        return cast(models.KnowledgeFile, self._http.json("PATCH", path, json_body=body))

    def delete_knowledge(self, file_id: str) -> None:
        self._http.request("DELETE", f"/api/knowledge/{path_segment(file_id)}")

    def knowledge_content(self, file_id: str) -> bytes:
        """The stored file itself."""
        return self._http.request("GET", f"/api/knowledge/{path_segment(file_id)}/content").content

    def knowledge_collections(self) -> list[models.CollectionInfo]:
        return cast(list[models.CollectionInfo], self._http.json("GET", "/api/knowledge/collections"))

    def search_knowledge(
        self,
        query: str,
        *,
        file_ids: Sequence[str] | None = None,
        k: int = 8,
        mode: Literal["fts", "vector", "hybrid"] | None = None,
    ) -> list[models.SearchHit]:
        """Search the knowledge base (``k`` 1 to 50 hits; ``mode`` full text, semantic or both, default the
        workspace's setting; a mode that is not available is an error, never a silent fallback)."""
        params: dict[str, Any] = {"q": query, "k": k}
        if file_ids:
            params["file_ids"] = ",".join(file_ids)
        if mode is not None:
            params["mode"] = mode
        return cast(list[models.SearchHit], self._http.json("GET", "/api/knowledge/search", params=params))

    # ---- input files (uploads for runs) --------------------------------------------------------

    def input_storage(self) -> models.StorageInfo:
        """How many input files there are and how much they take (in use by runs or not)."""
        return cast(models.StorageInfo, self._http.json("GET", "/api/inputs"))

    def input_formats(self) -> models.FormatsInfo:
        """The file formats Nodestro reads, by group, and the size limits."""
        return cast(models.FormatsInfo, self._http.json("GET", "/api/inputs/formats"))

    def upload_inputs(
        self,
        files: Sequence[str | os.PathLike[str] | tuple[str, bytes]],
        *,
        accept: str = "",
        max_size_mb: int | None = None,
    ) -> list[models.UploadResult]:
        """Upload files for a run (``file_ids`` of :meth:`start_run`). Each result has the stored ``file`` or a
        ``problem`` (refused format or size; the others are stored). ``accept`` narrows the formats like a form
        field's (``.pdf,.docx``). Not retried automatically."""
        parts = [("files", _upload(item, None, "file")) for item in _uploads(files)]
        data: dict[str, Any] = {"accept": accept, "origin": "sdk"}
        if max_size_mb is not None:
            data["max_size_mb"] = str(max_size_mb)
        return cast(list[models.UploadResult], self._http.json("POST", "/api/inputs", files=parts, data=data))

    def get_input(self, file_id: str) -> models.InputFileOut:
        return cast(models.InputFileOut, self._http.json("GET", f"/api/inputs/{path_segment(file_id)}"))

    def input_text(self, file_id: str, *, path: str = "") -> models.FileText:
        """What Nodestro read from a file (or, with ``path``, from one file of an archive): the text agents get."""
        params = {"path": path} if path else None
        return cast(models.FileText, self._http.json("GET", f"/api/inputs/{path_segment(file_id)}/text", params=params))

    def input_content(self, file_id: str) -> bytes:
        """The uploaded file itself."""
        return self._http.request("GET", f"/api/inputs/{path_segment(file_id)}/content").content

    def delete_input(self, file_id: str) -> None:
        self._http.request("DELETE", f"/api/inputs/{path_segment(file_id)}")

    def clean_up_inputs(self, *, older_than_days: int | None = None) -> models.InputCleanupResult:
        """Remove input files no run uses (``older_than_days``: only those older than that)."""
        body = {"older_than_days": older_than_days} if older_than_days is not None else {}
        return cast(models.InputCleanupResult, self._http.json("POST", "/api/inputs/cleanup", json_body=body))

    # ---- per-call tool approvals (only while the installation switched them on) ------------------

    def list_tool_approvals(self) -> list[models.ToolApprovalRequest]:
        """The open questions of runs paused at a tool call. Empty while ``NODESTRO_TOOL_APPROVALS`` is off (the
        default); the SDK never switches it on."""
        return cast(list[models.ToolApprovalRequest], self._http.json("GET", "/api/tool-approvals"))

    def run_tool_approvals(self, run_id: str) -> list[models.ToolApprovalRequest]:
        """Every tool approval question of one run, open or decided."""
        path = f"/api/runs/{path_segment(run_id)}/tool-approvals"
        return cast(list[models.ToolApprovalRequest], self._http.json("GET", path))

    def decide_tool_approval(
        self,
        run_id: str,
        request_id: str,
        decision: Literal["approved", "rejected"],
        *,
        arguments_hash: str,
        comment: str = "",
    ) -> models.ToolApprovalRequest:
        """Approve or reject one tool call. ``arguments_hash`` is the question's own (``arguments_hash`` of
        :meth:`list_tool_approvals`): a decision about other arguments than the ones shown is refused."""
        if decision not in ("approved", "rejected"):
            raise ValueError(f"decision must be 'approved' or 'rejected', not {decision!r}")
        path = f"/api/runs/{path_segment(run_id)}/tool-approvals/{path_segment(request_id)}"
        body = {"decision": decision, "arguments_hash": arguments_hash, "comment": comment}
        return cast(models.ToolApprovalRequest, self._http.json("POST", path, json_body=body))

    def tool_approval_audit(self, *, limit: int = 200) -> list[models.ToolApprovalEvent]:
        """The audit trail of tool approval questions and decisions, newest first."""
        return cast(
            list[models.ToolApprovalEvent], self._http.json("GET", "/api/tool-approvals/audit", params={"limit": limit})
        )

    # ---- exports of published workflows ---------------------------------------------------------

    def check_export(
        self,
        publication_id: str,
        options: models.ExportOptions | Mapping[str, Any] | None = None,
        *,
        number: int | None = None,
    ) -> models.ExportCheck:
        """What an export of a publication's release (``number``, default the active one) would contain and what
        keeps it from being built (``ok``, ``problems``); nothing is written."""
        path = f"/api/publications/{path_segment(publication_id)}/export/check"
        return cast(models.ExportCheck, self._http.json("POST", path, json_body=_export_body(options, number)))

    def create_export(
        self,
        publication_id: str,
        options: models.ExportOptions | Mapping[str, Any] | None = None,
        *,
        number: int | None = None,
    ) -> models.ExportRecord:
        """Export a release as a standalone project (``options.kind`` ``standard``, the default); a portable
        package is built by :meth:`start_export_job`."""
        path = f"/api/publications/{path_segment(publication_id)}/exports"
        return cast(models.ExportRecord, self._http.json("POST", path, json_body=_export_body(options, number)))

    def list_exports(self, publication_id: str) -> list[models.ExportRecord]:
        """The stored exports of a publication, newest first."""
        path = f"/api/publications/{path_segment(publication_id)}/exports"
        return cast(list[models.ExportRecord], self._http.json("GET", path))

    def download_export(self, export_id: str) -> bytes:
        """The ZIP of an export in memory (a portable package can be gigabytes: use :meth:`save_export`)."""
        return self._http.request("GET", f"/api/exports/{path_segment(export_id)}/download").content

    def save_export(self, export_id: str, target: str | os.PathLike[str] | IO[bytes]) -> int:
        """Stream the ZIP of an export to a path (written to a temporary file next to it first, so a cut
        download leaves no partial file) or a binary file object; returns the bytes written."""
        chunks = self._http.download(f"/api/exports/{path_segment(export_id)}/download", chunk_size=DOWNLOAD_CHUNK)
        with contextlib.closing(chunks):
            return save_chunks(chunks, target)

    def delete_export(self, export_id: str) -> None:
        """Delete an export and its ZIP (on a server this frees the workspace's export quota)."""
        self._http.request("DELETE", f"/api/exports/{path_segment(export_id)}")

    def start_export_job(
        self, publication_id: str, options: models.ExportOptions | Mapping[str, Any], *, number: int | None = None
    ) -> models.ExportJob:
        """Build a portable package in the background (``options.kind`` must be ``portable``); follow it with
        :meth:`get_export_job` or :meth:`wait_for_export_job`. Not retried automatically."""
        path = f"/api/publications/{path_segment(publication_id)}/export-jobs"
        return cast(models.ExportJob, self._http.json("POST", path, json_body=_export_body(options, number)))

    def list_export_jobs(self, publication_id: str) -> list[models.ExportJob]:
        path = f"/api/publications/{path_segment(publication_id)}/export-jobs"
        return cast(list[models.ExportJob], self._http.json("GET", path))

    def get_export_job(self, job_id: str) -> models.ExportJob:
        return cast(models.ExportJob, self._http.json("GET", f"/api/export-jobs/{path_segment(job_id)}"))

    def cancel_export_job(self, job_id: str) -> models.ExportJob:
        path = f"/api/export-jobs/{path_segment(job_id)}/cancel"
        return cast(models.ExportJob, self._http.json("POST", path))

    def wait_for_export_job(self, job_id: str, *, timeout: float = 3600.0, poll: float = 2.0) -> models.ExportJob:
        """Poll an export job until it is no longer ``running`` (``done``, ``failed`` with ``error_code``, or
        ``cancelled``); :class:`TimeoutError` after ``timeout`` seconds."""
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_export_job(job_id)
            if job.get("state") != "running":
                return job
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Export job {job_id} did not end within {timeout} seconds")
            time.sleep(poll)


def _uploads(
    files: Sequence[str | os.PathLike[str] | tuple[str, bytes]],
) -> list[str | os.PathLike[str] | tuple[str, bytes]]:
    if isinstance(files, (str, bytes, os.PathLike)) or (
        isinstance(files, tuple) and len(files) == 2 and isinstance(files[1], bytes)
    ):
        raise TypeError("files must be a list of paths or (filename, content) pairs")
    found = list(files)
    if not found:
        raise ValueError("files must name at least one file")
    return found


def _upload(
    file: str | os.PathLike[str] | bytes | IO[bytes] | tuple[str, bytes], filename: str | None, default: str
) -> tuple[str, bytes]:
    """``(name, content)`` of an upload: a path, the content, a binary file object or a ``(name, content)`` pair."""
    if isinstance(file, tuple):
        name, content = file
        return filename or name, content
    if isinstance(file, (str, os.PathLike)):
        with open(file, "rb") as handle:
            return filename or os.path.basename(os.fspath(file)), handle.read()
    if isinstance(file, bytes):
        return filename or default, file
    return filename or os.path.basename(str(getattr(file, "name", ""))) or default, file.read()


def _export_body(options: Mapping[str, Any] | None, number: int | None) -> dict[str, Any]:
    body: dict[str, Any] = {"options": dict(options or {})}
    if number is not None:
        body["number"] = number
    return body


def _amount(value: str | Decimal) -> str:
    """A USD amount as the decimal string the API expects; floats are refused so that no amount is rounded."""
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, str):
        return value
    raise TypeError(f"limit_usd must be a decimal string or Decimal, not {type(value).__name__}")


def _model_path(model: str) -> str:
    """A model id as the path tail of a price route: its ``/``-separated parts, each one a checked path segment."""
    return "/".join(path_segment(part) for part in model.split("/"))
