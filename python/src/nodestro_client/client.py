"""The client of the Nodestro API (the studio REST API under ``/api``).

The studio API is the one the Nodestro interface uses; it is local and has no keys of its own
(Nodestro listens on ``127.0.0.1`` by default). Published workflows have their own key-protected
API: :class:`~nodestro_client.published.PublishedWorkflow`.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
import time
from typing import Any, Literal, cast

import httpx

from . import models
from ._http import Event, RetryPolicy, Transport, path_segment
from .errors import NodestroRunFailed, NodestroTimeoutError

#: Run states that end a run, and the state of a run waiting for a person.
FINISHED = frozenset({"succeeded", "failed", "cancelled"})
WAITING = "paused"


class NodestroClient:
    """Workflows, runs, approvals, agents, tools and examples of a Nodestro installation.

    >>> with NodestroClient("http://127.0.0.1:8000") as nodestro:
    ...     run = nodestro.start_run(workflow_id, input="Thema X")
    ...     done = nodestro.wait_for_run(run["id"])
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

    def check_workflow(self, workflow: models.WorkflowIn | Mapping[str, Any], workflow_id: str | None = None) -> Any:
        """The pre-check of a run: problems per workflow and per agent (free, no model request)."""
        return self._http.json(
            "POST", "/api/workflows/check", json_body=dict(workflow), params={"workflow_id": workflow_id}
        )

    def workflow_versions(self, workflow_id: str) -> list[Any]:
        return cast(list[Any], self._http.json("GET", f"/api/workflows/{path_segment(workflow_id)}/versions"))

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
        """Wait until the run finished (or waits for a person, unless ``stop_at_approval`` is off)."""
        deadline = time.monotonic() + timeout
        while True:
            run = self.get_run(run_id)
            status = run.get("status")
            if status in FINISHED or (stop_at_approval and status == WAITING):
                if raise_on_failure and status in ("failed", "cancelled"):
                    raise NodestroRunFailed(cast(dict[str, Any], run))
                return run
            if time.monotonic() >= deadline:
                raise NodestroTimeoutError(f"Run {run_id} is still {status} after {timeout:g} s")
            time.sleep(poll)

    def events(self, run_id: str, *, timeout: float | None = None) -> Iterator[Event]:
        """The live events of a run: ``snapshot`` (the run), ``event`` (one step), ``end``."""
        return self._http.events(f"/api/runs/{path_segment(run_id)}/events", timeout=timeout)

    def run_files(self, run_id: str) -> list[Any]:
        return cast(list[Any], self._http.json("GET", f"/api/runs/{path_segment(run_id)}/files"))

    def download_file(self, run_id: str, file_id: str) -> bytes:
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
        return cast(list[models.ConfigIssue], self._http.json("POST", "/api/agents/validate", json_body=dict(agent)))

    def list_agent_templates(self) -> list[Any]:
        return cast(list[Any], self._http.json("GET", "/api/agents/templates"))

    def create_agent_template(self, template: Mapping[str, Any]) -> Any:
        return self._http.json("POST", "/api/agents/templates", json_body=dict(template))

    def update_agent_template(self, template_id: str, template: Mapping[str, Any]) -> Any:
        return self._http.json("PUT", f"/api/agents/templates/{path_segment(template_id)}", json_body=dict(template))

    def delete_agent_template(self, template_id: str) -> None:
        self._http.request("DELETE", f"/api/agents/templates/{path_segment(template_id)}")

    def list_tools(self) -> list[Any]:
        return cast(list[Any], self._http.json("GET", "/api/tools"))

    def list_examples(self, language: str | None = None) -> list[models.TemplateSummary]:
        return cast(list[models.TemplateSummary], self._http.json("GET", "/api/library", params={"language": language}))

    def copy_example(self, template_id: str, *, language: str | None = None, tests: bool = False) -> models.Workflow:
        body = {"language": language, "tests": tests}
        return cast(
            models.Workflow, self._http.json("POST", f"/api/library/{path_segment(template_id)}/copy", json_body=body)
        )

    # ---- publishing ------------------------------------------------------------------------

    def publish(self, workflow_id: str, **options: Any) -> Any:
        """Publish the workflow as an API (options: ``slug``, ``note``, ``version``, ``activate``)."""
        return self._http.json("POST", f"/api/workflows/{path_segment(workflow_id)}/api/publish", json_body=options)

    def create_api_key(self, name: str, scopes: Sequence[str], publications: Sequence[str]) -> models.NewApiKey:
        """A key for published workflows; its ``token`` is returned only this once."""
        body: models.KeyIn = {"name": name, "scopes": cast(Any, list(scopes)), "publications": list(publications)}
        return cast(models.NewApiKey, self._http.json("POST", "/api/api-keys", json_body=body))
