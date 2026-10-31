"""The client of the Nodestro API (the studio REST API under ``/api``).

The studio API is the one the Nodestro interface uses; it is local and has no keys of its own
(Nodestro listens on ``127.0.0.1`` by default). Published workflows have their own key-protected
API: :class:`~nodestro_client.published.PublishedWorkflow`.
"""

from __future__ import annotations

from collections.abc import Generator, Mapping, Sequence
from typing import Any, Literal, cast

import httpx

from . import models
from ._http import Event, RetryPolicy, Transport, path_segment, poll_until
from .errors import NodestroRunFailed

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
    that changes something. ``headers`` are sent with every request. An ``http_client`` passed in
    is used as is (its proxies, certificates and limits) and is not closed by :meth:`close`.

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

    def settings(self) -> models.Settings:
        """The settings as the interface shows them (API keys are never returned)."""
        return cast(models.Settings, self._http.json("GET", "/api/settings"))

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

    def update_workflow(self, workflow_id: str, workflow: models.WorkflowIn | Mapping[str, Any]) -> models.Workflow:
        return cast(
            models.Workflow,
            self._http.json("PUT", f"/api/workflows/{path_segment(workflow_id)}", json_body=dict(workflow)),
        )

    def delete_workflow(self, workflow_id: str) -> None:
        self._http.request("DELETE", f"/api/workflows/{path_segment(workflow_id)}")

    def check_workflow(
        self, workflow: models.WorkflowIn | Mapping[str, Any], workflow_id: str | None = None
    ) -> models.WorkflowCheck:
        """The pre-check of a run: problems per workflow and per agent (free, no model request)."""
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
    ) -> models.Run:
        """Start a run; it runs in the background (see :meth:`wait_for_run` and :meth:`events`)."""
        body: models.RunIn = {"input": input, "values": dict(values or {}), "file_ids": list(file_ids)}
        return cast(
            models.Run, self._http.json("POST", f"/api/workflows/{path_segment(workflow_id)}/runs", json_body=body)
        )

    def get_run(self, run_id: str) -> models.Run:
        return cast(models.Run, self._http.json("GET", f"/api/runs/{path_segment(run_id)}"))

    def list_runs(self, *, workflow_id: str | None = None, limit: int | None = None) -> list[models.RunSummary]:
        return cast(
            list[models.RunSummary],
            self._http.json("GET", "/api/runs", params={"workflow_id": workflow_id, "limit": limit}),
        )

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

        Polls the run every ``poll`` seconds. ``timeout`` is the total wait in seconds; the last
        status request may still take up to the client's request timeout. Raises
        :class:`NodestroTimeoutError` when the run has not ended by then (the run keeps running),
        and :class:`NodestroRunFailed` for a failed or cancelled run if ``raise_on_failure``.
        """
        run = poll_until(
            lambda: self.get_run(run_id),
            lambda found: found.get("status") in FINISHED or (stop_at_approval and found.get("status") == WAITING),
            run_id=run_id,
            timeout=timeout,
            poll=poll,
        )
        if raise_on_failure and run.get("status") in ("failed", "cancelled"):
            raise NodestroRunFailed(cast(dict[str, Any], run))
        return run

    def events(self, run_id: str, *, timeout: float | None = None) -> Generator[Event, None, None]:
        """The live events of a run: ``snapshot`` (the run), ``event`` (one step), ``end``.

        The connection stays open until the run ends. Leaving the loop early closes it when the
        generator is collected; ``with contextlib.closing(nodestro.events(run_id)) as events:``
        closes it at once. ``timeout`` limits the wait for the next line in seconds.
        """
        return self._http.events(f"/api/runs/{path_segment(run_id)}/events", timeout=timeout)

    def run_files(self, run_id: str) -> list[models.ResultFile]:
        """The result files of a run (documents written by its output steps)."""
        return cast(list[models.ResultFile], self._http.json("GET", f"/api/runs/{path_segment(run_id)}/files"))

    def download_file(self, run_id: str, file_id: str) -> bytes:
        """The content of a result file (held in memory as a whole)."""
        return self._http.request("GET", f"/api/runs/{path_segment(run_id)}/files/{path_segment(file_id)}").content

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


def _model_path(model: str) -> str:
    """A model id as the path tail of a price route: its ``/``-separated parts, each one a checked path segment."""
    return "/".join(path_segment(part) for part in model.split("/"))
