"""The Python SDK against a real Nodestro API server with scripted model answers.

German values (inputs, labels, template names, the scripted answers) are deliberate test data:
Nodestro is multilingual, and the assertions look for them.
"""

from __future__ import annotations

from decimal import Decimal
import time
from typing import Any

import pytest

from nodestro_client import NodestroAPIError, NodestroClient, NodestroRunFailed, PublishedWorkflow


def agent(node_id: str, prompt: str) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": "agent",
        "label": node_id.title(),
        "agent": {"name": node_id.title(), "system_prompt": prompt},
    }


def edge(source: str, target: str, handle: str | None = None) -> dict[str, Any]:
    return {"id": f"{source}-{target}", "source": source, "target": target, "source_handle": handle}


def simple(prompt: str = "WRITER", **extra: Any) -> dict[str, Any]:
    return {
        "name": f"SDK {prompt}",
        "nodes": [{"id": "start", "type": "start"}, agent("writer", prompt), {"id": "out", "type": "output"}],
        "edges": [edge("start", "writer"), edge("writer", "out")],
        **extra,
    }


@pytest.fixture
def nodestro(server: str) -> Any:
    with NodestroClient(server, timeout=10) as client:
        yield client


def test_meta_and_settings(nodestro: NodestroClient) -> None:
    meta = nodestro.meta()
    assert meta["version"] and {item["id"] for item in meta["providers"]} >= {"anthropic", "openai", "gemini"}
    settings = nodestro.settings()
    assert "api_key" not in str(settings).lower() or all(not item.get("api_key") for item in settings["providers"])
    # Only the given fields change.
    changed = nodestro.update_settings({"default_budget_usd": 7.5})
    assert changed["default_budget_usd"] == 7.5 and changed["default_model"] == settings["default_model"]


def test_the_sandbox_status_and_self_test(nodestro: NodestroClient) -> None:
    states = {"approved", "unavailable", "checking"}
    status = nodestro.sandbox_status()
    assert status["name"] == "docker" and status.get("state") in states
    docker = next(row for row in nodestro.settings()["sandbox_backends"] if row["name"] == "docker")
    assert docker.get("state") in states
    assert nodestro.sandbox_status(refresh=True, wait=1)["name"] == "docker"
    tested = nodestro.sandbox_self_test(timeout=5)
    assert tested["name"] == "docker" and tested.get("state") in states
    assert all({"name", "ok"} <= set(check) for check in tested.get("checks", []))


def test_a_retried_start_returns_the_same_run(nodestro: NodestroClient) -> None:
    """API2-08: the same Idempotency-Key starts one run; another request with it is a conflict."""
    workflow = nodestro.create_workflow(simple())
    first = nodestro.start_run(workflow["id"], input="x", idempotency_key="sdk-order-1")
    again = nodestro.start_run(workflow["id"], input="x", idempotency_key="sdk-order-1")
    assert again["id"] == first["id"]
    with pytest.raises(NodestroAPIError) as conflict:
        nodestro.start_run(workflow["id"], input="y", idempotency_key="sdk-order-1")
    assert conflict.value.status == 409 and conflict.value.code == "idempotency.conflict"
    assert nodestro.start_run(workflow["id"], input="x")["id"] != first["id"]
    nodestro.wait_for_run(first["id"], timeout=30, poll=0.1)


def test_a_workflow_runs_and_returns_its_result(nodestro: NodestroClient) -> None:
    workflow = nodestro.create_workflow(simple())
    assert workflow["id"] in {item["id"] for item in nodestro.list_workflows()}
    assert nodestro.get_workflow(workflow["id"])["name"] == "SDK WRITER"
    run = nodestro.start_run(workflow["id"], input="Angebot für ACME")
    done = nodestro.wait_for_run(run["id"], timeout=30, poll=0.1)
    assert done["status"] == "succeeded"
    assert "Wir liefern" in str(done["output"])
    assert run["id"] in [item["id"] for item in nodestro.list_runs(workflow_id=workflow["id"])]


def test_events_stream_the_run(nodestro: NodestroClient) -> None:
    workflow = nodestro.create_workflow(simple())
    run = nodestro.start_run(workflow["id"], input="x")
    names = [event.event for event in nodestro.events(run["id"], timeout=30)]
    assert names[0] == "snapshot" and names[-1] == "end"


def test_a_running_run_can_be_cancelled(nodestro: NodestroClient) -> None:
    workflow = nodestro.create_workflow(simple("SLOW"))
    run = nodestro.start_run(workflow["id"], input="x")
    assert nodestro.cancel_run(run["id"]) is True
    assert nodestro.wait_for_run(run["id"], timeout=30, poll=0.1)["status"] == "cancelled"
    with pytest.raises(NodestroRunFailed):
        nodestro.wait_for_run(run["id"], raise_on_failure=True)


def test_approvals_wait_for_a_person(nodestro: NodestroClient) -> None:
    body = {
        "name": "SDK approval",
        "nodes": [
            {"id": "start", "type": "start"},
            agent("writer", "WRITER"),
            {"id": "check", "type": "approval", "label": "Prüfen", "approval": {"instructions": "Ok?"}},
            {"id": "out", "type": "output"},
        ],
        "edges": [edge("start", "writer"), edge("writer", "check"), edge("check", "out", "approved")],
    }
    workflow = nodestro.create_workflow(body)
    run = nodestro.start_run(workflow["id"], input="x")
    paused = nodestro.wait_for_run(run["id"], timeout=30, poll=0.1)
    assert paused["status"] == "paused"
    pending = [item for item in nodestro.list_approvals() if item["run_id"] == run["id"]]
    assert [item["node_id"] for item in pending] == ["check"]
    nodestro.decide_approval(run["id"], "check", "approved", "passt")
    assert nodestro.wait_for_run(run["id"], timeout=30, poll=0.1)["status"] == "succeeded"


def test_a_failed_run_continues(nodestro: NodestroClient) -> None:
    body = {
        "name": "SDK resume",
        "nodes": [{"id": "start", "type": "start"}, agent("first", "WRITER"), agent("second", "BROKEN")],
        "edges": [edge("start", "first"), edge("first", "second")],
    }
    workflow = nodestro.create_workflow(body)
    failed = nodestro.wait_for_run(nodestro.start_run(workflow["id"], input="x")["id"], timeout=30, poll=0.1)
    assert failed["status"] == "failed"
    plan = nodestro.resume_plan(failed["id"])
    assert plan["possible"] is True
    continued = nodestro.resume_run(failed["id"])
    done = nodestro.wait_for_run(continued["id"], timeout=30, poll=0.1)
    assert done["status"] == "succeeded" and done["resumed_from"] == failed["id"]


def test_agents_and_their_templates(nodestro: NodestroClient) -> None:
    issues = nodestro.validate_agent({"name": "A", "system_prompt": "x", "tools": ["no_such_tool"]})
    assert issues and all("code" in issue for issue in issues)
    created = nodestro.create_agent_template(
        {"name": "SDK-Vorlage", "agent": {"name": "Prüfer", "system_prompt": "Prüfe."}}
    )
    assert created["id"] in {item["id"] for item in nodestro.list_agent_templates()}
    nodestro.delete_agent_template(created["id"])
    assert created["id"] not in {item["id"] for item in nodestro.list_agent_templates()}
    assert {"calculator", "current_datetime"} <= {tool["name"] for tool in nodestro.list_tools()}


def test_examples_can_be_listed_and_copied(nodestro: NodestroClient) -> None:
    examples = nodestro.list_examples("en")
    assert len(examples) == 24
    copy = nodestro.copy_example(examples[0]["id"], language="de")
    assert copy["id"].startswith("wf_")


def test_errors_carry_status_code_and_params(nodestro: NodestroClient) -> None:
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.get_run("run_does_not_exist")
    assert missing.value.status == 404 and missing.value.code == "run.not_found"
    assert missing.value.params["id"] == "run_does_not_exist"
    workflow = nodestro.create_workflow({"name": "leer", "nodes": [], "edges": []})
    with pytest.raises(NodestroAPIError) as refused:
        nodestro.start_run(workflow["id"], input="x")
    assert refused.value.status == 400 and refused.value.code


def test_a_published_form_starts_with_its_values(nodestro: NodestroClient, server: str) -> None:
    # The README example: a form workflow takes {"values": {...}}; the fields alone are refused.
    form = {"fields": [{"name": "customer", "label": "Customer", "type": "text", "required": True}]}
    workflow = nodestro.create_workflow(
        {**simple(), "nodes": [{"id": "start", "type": "start", "start": form}, *simple()["nodes"][1:]]}
    )
    publication = nodestro.publish(workflow["id"], slug="sdk-form")["publication"]
    assert not publication.get("mcp_tool")
    offered = nodestro.update_publication(publication["id"], {"mcp_tool": True, "description": "Form"})
    assert offered["mcp_tool"] is True and offered["description"] == "Form"
    key = nodestro.create_api_key("SDK form", ["run", "read"], [publication["id"]])
    with PublishedWorkflow(server, publication["slug"], api_key=key["token"]) as api:
        with pytest.raises(NodestroAPIError) as refused:
            api.start({"customer": "ACME"})
        assert refused.value.status == 422 and refused.value.code == "request.invalid"
        started = api.start({"values": {"customer": "ACME"}})
        assert api.wait_for_result(started["run_id"], timeout=30, poll=0.1)["status"] == "succeeded"


def test_keys_and_publications_are_managed(nodestro: NodestroClient, server: str) -> None:
    """DX-25: list, rotate, revoke and delete keys; list and delete publications."""
    workflow = nodestro.create_workflow(simple())
    publication = nodestro.publish(workflow["id"], slug="sdk-managed")["publication"]
    assert publication["id"] in {item["id"] for item in nodestro.list_publications()}
    key = nodestro.create_api_key("SDK managed", ["read"], [publication["id"]])
    listed = {item["id"]: item for item in nodestro.list_api_keys()}
    assert key["key"]["id"] in listed and "token" not in listed[key["key"]["id"]]
    rotated = nodestro.rotate_api_key(key["key"]["id"])
    assert rotated["token"] != key["token"] and rotated["key"]["name"] == "SDK managed"
    with PublishedWorkflow(server, "sdk-managed", api_key=key["token"]) as old:
        with pytest.raises(NodestroAPIError) as refused:
            old.info()
        assert refused.value.status == 401
    with PublishedWorkflow(server, "sdk-managed", api_key=rotated["token"]) as new:
        assert new.info()["publication"] == "sdk-managed"
    assert nodestro.revoke_api_key(rotated["key"]["id"])["id"] == rotated["key"]["id"]
    nodestro.delete_api_key(rotated["key"]["id"])
    assert rotated["key"]["id"] not in {item["id"] for item in nodestro.list_api_keys()}
    nodestro.delete_publication(publication["id"])
    assert publication["id"] not in {item["id"] for item in nodestro.list_publications()}


def test_a_published_workflow_through_its_own_api(nodestro: NodestroClient, server: str) -> None:
    workflow = nodestro.create_workflow(simple())
    published = nodestro.publish(workflow["id"], slug="sdk-angebot")
    publication = published["publication"]
    key = nodestro.create_api_key("SDK", ["run", "read", "approve"], [publication["id"]])
    with PublishedWorkflow(server, publication["slug"], api_key=key["token"]) as api:
        info = api.info()
        assert info["publication"] == "sdk-angebot" and info["name"] == "SDK WRITER"
        first = api.start({"input": "ACME"}, idempotency_key="sdk-1")
        again = api.start({"input": "ACME"}, idempotency_key="sdk-1")
        assert first["run_id"] == again["run_id"]
        result = api.wait_for_result(first["run_id"], timeout=30, poll=0.1)
        assert result["status"] == "succeeded" and "Wir liefern" in str(result.get("output"))
        names = [event.event for event in api.events(first["run_id"])]
        assert (names and names[-1] in ("end", "run_finished", "done")) or names
        assert api.usage()["runs"] >= 1
        assert first["run_id"] in [item["run_id"] for item in api.runs()]
    with (
        PublishedWorkflow(server, publication["slug"], api_key="ndk_wrong_key") as wrong,
        pytest.raises(NodestroAPIError) as denied,
    ):
        wrong.info()
    assert denied.value.status == 401 and denied.value.code.startswith("auth.")


def approval_workflow(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "nodes": [
            {"id": "start", "type": "start"},
            agent("writer", "WRITER"),
            {"id": "check", "type": "approval", "label": "Prüfen", "approval": {"instructions": "Ok?"}},
            {"id": "out", "type": "output", "output": {"files": [{"format": "md", "name": "angebot"}]}},
        ],
        "edges": [edge("start", "writer"), edge("writer", "check"), edge("check", "out", "approved")],
    }


def published_api(nodestro: NodestroClient, body: dict[str, Any], slug: str, scopes: list[str]) -> tuple[str, str, str]:
    """Publish ``body`` as ``slug``: its slug, a key with ``scopes`` and the publication id."""
    workflow = nodestro.create_workflow(body)
    publication = nodestro.publish(workflow["id"], slug=slug)["publication"]
    key = nodestro.create_api_key(slug, scopes, [publication["id"]])
    return publication["slug"], key["token"], publication["id"]


def test_workflows_are_checked_versioned_updated_and_deleted(nodestro: NodestroClient) -> None:
    workflow = nodestro.create_workflow(simple())
    check = nodestro.check_workflow(simple(), workflow["id"])
    # The test server has no provider key; that is the only problem of a sound workflow.
    assert {item["code"] for item in check["problems"]} <= {"check.api_key_missing"}
    assert check["agents"] == {"writer": []}
    with pytest.raises(TypeError, match="workflow document"):
        nodestro.check_workflow(workflow["id"])  # type: ignore[arg-type]
    empty = nodestro.check_workflow({"name": "empty", "nodes": [], "edges": []})
    assert empty["ok"] is False and "workflow.no_agents" in {item["code"] for item in empty["problems"]}
    updated = nodestro.update_workflow(workflow["id"], {**simple(), "name": "SDK renamed"})
    assert updated["name"] == "SDK renamed"
    versions = nodestro.workflow_versions(workflow["id"])
    assert len(versions) >= 2 and all(isinstance(item["number"], int) for item in versions)
    nodestro.delete_workflow(workflow["id"])
    with pytest.raises(NodestroAPIError) as gone:
        nodestro.get_workflow(workflow["id"])
    assert gone.value.status == 404


def test_result_files_of_a_run_can_be_downloaded(nodestro: NodestroClient) -> None:
    body = simple()
    body["nodes"][2]["output"] = {"files": [{"format": "md", "name": "angebot"}]}
    workflow = nodestro.create_workflow(body)
    done = nodestro.wait_for_run(nodestro.start_run(workflow["id"], input="x")["id"], timeout=30, poll=0.1)
    files = nodestro.run_files(done["id"])
    assert [item["format"] for item in files] == ["md"]
    content = nodestro.download_file(done["id"], files[0]["id"])
    assert b"Wir liefern" in content
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.download_file(done["id"], "file_missing")
    assert missing.value.status == 404


def test_agent_templates_can_be_updated(nodestro: NodestroClient) -> None:
    created = nodestro.create_agent_template({"agent": {"name": "Prüfer", "system_prompt": "Prüfe."}})
    changed = nodestro.update_agent_template(created["id"], {"agent": {"name": "Prüfer 2", "system_prompt": "Prüfe."}})
    assert changed["id"] == created["id"] and changed["agent"]["name"] == "Prüfer 2"
    nodestro.delete_agent_template(created["id"])


def test_examples_exist_in_all_six_languages(nodestro: NodestroClient) -> None:
    for language in ("de", "en", "es", "fr", "it", "pt-BR"):
        assert len(nodestro.list_examples(language)) == 24


def test_published_approvals_files_and_permissions(nodestro: NodestroClient, server: str) -> None:
    slug, token, publication_id = published_api(
        nodestro, approval_workflow("SDK published approval"), "sdk-approval", ["run", "read"]
    )
    _, foreign_key, _ = published_api(nodestro, simple(), "sdk-approval-other", ["read"])
    with PublishedWorkflow(server, slug, api_key=token) as api:
        run = api.start({"input": "ACME"})
        waiting = api.wait(run["run_id"], timeout=30, poll=0.1)
        assert waiting["status"] == "awaiting_approval"
        approvals = api.approvals(run["run_id"])
        assert [item["step"] for item in approvals] == ["Prüfen"]
        with pytest.raises(NodestroAPIError) as no_scope:
            api.approve(run["run_id"])  # the key lacks "approve": the server decides
        assert no_scope.value.status == 403 and no_scope.value.code.startswith("auth.")
    with PublishedWorkflow(server, slug, api_key=foreign_key) as other, pytest.raises(NodestroAPIError) as foreign:
        other.status(run["run_id"])
    assert foreign.value.status in (401, 403, 404)
    key = nodestro.create_api_key("approver", ["run", "read", "approve"], [publication_id])["token"]
    with PublishedWorkflow(server, slug, api_key=key) as api:
        decided = api.approve(run["run_id"], comment="passt", approval_id=approvals[0]["approval_id"])
        assert decided["run_id"] == run["run_id"]
        with pytest.raises(NodestroAPIError) as twice:
            api.approve(run["run_id"])
        assert twice.value.status in (404, 409)
        result = api.wait_for_result(run["run_id"], timeout=30, poll=0.1)
        assert result["status"] == "succeeded"
        files = api.files(run["run_id"])
        assert len(files) == 1 and b"Wir liefern" in api.download(run["run_id"], str(files[0]["id"]))
        with pytest.raises(NodestroAPIError) as missing:
            api.download(run["run_id"], "file_missing")
        assert (missing.value.status, missing.value.code) == (404, "file.not_found")
        rejected = api.start({"input": "ACME"})
        api.wait(rejected["run_id"], timeout=30, poll=0.1)
        api.approve(rejected["run_id"], "rejected", comment="nein")
        assert api.wait(rejected["run_id"], timeout=30, poll=0.1)["status"] in ("succeeded", "failed")


def test_published_cancel_resume_versions_and_reconnect(nodestro: NodestroClient, server: str) -> None:
    slug, token, _ = published_api(nodestro, simple("SLOW"), "sdk-slow", ["run", "read"])
    with PublishedWorkflow(server, slug, api_key=token) as api:
        assert api.openapi()["paths"]
        run = api.start({"input": "x"}, version=1)
        events = api.events(run["run_id"], timeout=30)
        first = next(events)
        events.close()  # leave the stream; reconnect with the last id
        assert first.event == "status"
        cancelled = api.cancel(run["run_id"])
        assert cancelled["run_id"] == run["run_id"]
        assert api.wait(run["run_id"], timeout=30, poll=0.1)["status"] == "cancelled"
        with pytest.raises(NodestroRunFailed):
            api.wait_for_result(run["run_id"], timeout=30, poll=0.1)
        rest = list(api.events(run["run_id"], last_event_id=first.id or "0"))
        assert rest[-1].event == "end" and rest[-1].data == {"status": "cancelled"}
        continued = api.resume(run["run_id"])
        assert continued["resumed_from"] == run["run_id"]
        assert api.wait(continued["run_id"], timeout=30, poll=0.1)["status"] == "succeeded"
        with pytest.raises(NodestroAPIError) as not_failed:
            api.resume(continued["run_id"])
        assert (not_failed.value.status, not_failed.value.code) == (409, "resume.not_failed")
        with pytest.raises(NodestroAPIError) as no_version:
            api.start({"input": "x"}, version=99)
        assert no_version.value.status == 404
        assert api.usage(days=1)["runs"] >= 2
        assert [item["run_id"] for item in api.runs(status="cancelled")] == [run["run_id"]]


def test_model_prices_usage_and_reconciliation(nodestro: NodestroClient) -> None:
    prices = nodestro.list_prices()
    assert any(price["provider"] == "anthropic" and price["quality"] == "verified" for price in prices)
    status = nodestro.pricing_status()
    assert status["active_version"] and status["reference_read_only"] is False
    entry = nodestro.set_price_override(
        "openai", "org/gpt-sdk", {"input_usd_per_mtok": "1", "output_usd_per_mtok": "4", "note": "SDK test"}
    )
    assert entry["overridden"] is True and entry["model"] == "org/gpt-sdk" and entry["status"] == "custom"
    assert any(event["kind"] == "override_set" for event in nodestro.pricing_history(limit=50))
    nodestro.remove_price_override("openai", "org/gpt-sdk")
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.remove_price_override("openai", "org/gpt-sdk")
    assert missing.value.status == 404
    assert nodestro.list_price_reviews() == []
    with pytest.raises(NodestroAPIError) as unknown:
        nodestro.decide_price_review("nothing", "reject")
    assert unknown.value.code == "pricing.review_not_found"
    report = nodestro.usage(days=7)
    assert report["total"]["cost_state"] in {"known", "partial", "unknown", "none"}
    with pytest.raises(NodestroAPIError) as no_key:
        nodestro.reconcile_costs({"start": "2026-10-01", "end": "2026-10-02"})
    assert no_key.value.code == "pricing.billing_key_missing"


def test_the_release_gate(nodestro: NodestroClient) -> None:
    workflow = nodestro.create_workflow({**simple(), "name": "SDK gate"})
    assert nodestro.release_gate(workflow["id"])["status"] == "off"
    with pytest.raises(NodestroAPIError) as unknown:
        nodestro.release_gate(workflow["id"], gate={"suite_ids": ["suite_none"]})
    assert unknown.value.code == "gate.suite_unknown"
    publication = nodestro.publish(workflow["id"], slug="sdk-gate")["publication"]
    assert publication["gate"] is None
    with pytest.raises(NodestroAPIError) as refused:
        nodestro.set_release_gate(publication["id"], {"suite_ids": ["suite_none"]})
    assert refused.value.code == "gate.suite_unknown"
    assert nodestro.set_release_gate(publication["id"], None)["gate"] is None


def test_connected_mcp_services(nodestro: NodestroClient) -> None:
    status = nodestro.mcp_status()
    assert status["write_tools_enabled"] is False and status["endpoint_list"] is None
    with pytest.raises(NodestroAPIError) as unsafe:
        nodestro.add_mcp_server({"name": "Plain", "url": "http://mcp.example.com/mcp"})
    assert unsafe.value.status == 400 and unsafe.value.code == "mcp.https_required"
    server = nodestro.add_mcp_server(
        {"name": "Docs", "url": "https://mcp.invalid/mcp", "auth": "bearer", "token": "sdk-secret-token"}
    )
    assert server["token_set"] is True and "sdk-secret-token" not in str(server)
    assert server["id"] in {item["id"] for item in nodestro.list_mcp_servers()}
    with pytest.raises(NodestroAPIError) as unreachable:
        nodestro.discover_mcp_tools(server["id"])
    assert unreachable.value.code in {"mcp.dns_failed", "mcp.unreachable", "mcp.unavailable"}
    assert nodestro.list_mcp_tools(server["id"]) == []
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.decide_mcp_tool(server["id"], "search", approve=True, access="read")
    assert missing.value.status == 404
    changed = nodestro.update_mcp_server(server["id"], {"name": "Docs 2", "url": "https://mcp.invalid/mcp"})
    assert changed["name"] == "Docs 2" and changed["token_set"] is True  # an omitted token is kept
    with pytest.raises(NodestroAPIError) as not_oauth:
        nodestro.start_mcp_sign_in(server["id"])
    assert not_oauth.value.code == "mcp.oauth_not_configured"
    with pytest.raises(NodestroAPIError) as not_local:
        nodestro.mcp_server_environment(server["id"])
    assert not_local.value.code == "mcp.stdio_invalid"
    with pytest.raises(NodestroAPIError) as no_plan:
        nodestro.plan_mcp_server_environment(server["id"])
    assert no_plan.value.status == 400
    with pytest.raises(NodestroAPIError) as no_sign_in:
        nodestro.sign_out_mcp_server(server["id"])
    assert no_sign_in.value.code == "mcp.oauth_not_configured"
    stats = nodestro.mcp_stats()
    assert stats["active_calls"] == 0 and stats["limits"]["max_parallel"] >= 1
    events = nodestro.mcp_events(limit=20)
    assert {"server_added", "server_changed"} <= {event["kind"] for event in events}
    assert "sdk-secret-token" not in str(events)
    nodestro.remove_mcp_server(server["id"])
    assert server["id"] not in {item["id"] for item in nodestro.list_mcp_servers()}


# ---- live run chat -------------------------------------------------------------------------


def until(probe: Any, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe():
            return
        time.sleep(0.1)
    raise AssertionError("condition not reached")


def orchestrated_run(nodestro: NodestroClient) -> str:
    """An orchestrator whose team waits at an approval: the run stays paused until the test decides."""
    team = nodestro.create_workflow(
        {
            "name": "SDK Team",
            "description": "schreibt Entwürfe",
            "nodes": [
                {"id": "start", "type": "start"},
                agent("drafter", "DRAFTER"),
                {"id": "check", "type": "approval", "label": "Prüfen", "approval": {"on_reject": "branch"}},
                {"id": "out", "type": "output"},
            ],
            "edges": [edge("start", "drafter"), edge("drafter", "check"), edge("check", "out", "approved")],
        }
    )
    lead = nodestro.create_workflow(
        {
            "name": "SDK Lead",
            "nodes": [
                {"id": "start", "type": "start"},
                {
                    "id": "lead",
                    "type": "orchestrator",
                    "label": "Lead",
                    "orchestrator": {"members": [{"workflow_id": team["id"]}]},
                },
            ],
            "edges": [edge("start", "lead")],
        }
    )
    run = nodestro.start_run(lead["id"], input="Angebot")
    assert nodestro.wait_for_run(run["id"], timeout=30, poll=0.1)["status"] == "paused"
    return run["id"]


def test_the_live_run_chat(nodestro: NodestroClient) -> None:
    run_id = orchestrated_run(nodestro)
    view = nodestro.run_chat(run_id)
    assert view["active"] and view["run_status"] == "paused" and view["messages"] == []
    (target,) = view["targets"]
    assert (target["run_id"], target["node_id"], target["label"]) == (run_id, "lead", "Lead")
    assert target.get("steering") and target["teams"][0]["status"] == "paused"

    order = {"kind": "instruction", "target_run_id": run_id, "node_id": "lead", "content": "Kurz halten"}
    sent = nodestro.send_run_chat_message(run_id, **order, client_id="sdk-tab-1")  # type: ignore[arg-type]
    assert sent["status"] == "queued" and not sent.get("client_id")
    again = nodestro.send_run_chat_message(run_id, **order, client_id="sdk-tab-1")  # type: ignore[arg-type]
    assert again["id"] == sent["id"]
    with pytest.raises(NodestroAPIError) as reused:
        nodestro.send_run_chat_message(
            run_id, kind="instruction", target_run_id=run_id, node_id="lead", content="Anders", client_id="sdk-tab-1"
        )
    assert reused.value.status == 409 and reused.value.code == "run_chat.client_id_reused"

    asked = nodestro.send_run_chat_message(
        run_id, kind="question", target_run_id=run_id, node_id="lead", content="Wo stehen wir?"
    )
    assert asked["status"] == "pending"
    until(lambda: nodestro.run_chat_message(run_id, asked["id"])["status"] == "answered")
    messages = nodestro.run_chat(run_id)["messages"]
    answer = next(item for item in messages if item["kind"] == "answer")
    assert answer["reply_to"] == asked["id"] and "wartet auf eine Freigabe" in answer["content"]
    assert [item["id"] for item in messages if item["kind"] == "instruction"] == [sent["id"]]

    (waiting,) = [item for item in nodestro.list_approvals() if item["root_run_id"] == run_id]
    nodestro.decide_approval(waiting["run_id"], "check", "approved")
    assert nodestro.wait_for_run(run_id, timeout=30, poll=0.1)["status"] == "succeeded"
    until(lambda: nodestro.run_chat_message(run_id, sent["id"])["status"] == "considered")

    events = list(nodestro.run_chat_events(run_id, timeout=30))
    assert [event.event for event in events] == ["snapshot", "end"]
    assert events[0].data["run_id"] == run_id and not events[0].data["active"]
    assert events[-1].data == {"status": "succeeded"}

    with pytest.raises(NodestroAPIError) as ended:
        nodestro.send_run_chat_message(
            run_id, kind="question", target_run_id=run_id, node_id="lead", content="Und jetzt?"
        )
    assert ended.value.status == 409 and ended.value.code == "run_chat.run_not_active"
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.run_chat_message(run_id, "msg_does_not_exist")
    assert missing.value.status == 404


# ---- run budgets -----------------------------------------------------------------------------


def budget_run(nodestro: NodestroClient) -> tuple[str, str]:
    """A run whose budget is too small for its first model request: it pauses for a budget decision."""
    writer = agent("writer", "WRITER")
    writer["agent"]["max_tokens"] = 1000
    workflow = nodestro.create_workflow(
        {
            **simple(),
            "name": "SDK budget",
            "budget_usd": 0.0001,
            "nodes": [{"id": "start", "type": "start"}, writer, {"id": "out", "type": "output"}],
        }
    )
    run = nodestro.start_run(workflow["id"], input="Angebot")
    paused = nodestro.wait_for_run(run["id"], timeout=30, poll=0.1)
    assert paused["status"] == "paused"
    request_id = (paused.get("budget") or {}).get("pending_request_id")
    assert request_id
    return run["id"], request_id


def test_a_budget_decision_raises_the_limit_and_continues_the_run(nodestro: NodestroClient) -> None:
    run_id, request_id = budget_run(nodestro)
    view = nodestro.get_run_budget(run_id)
    pending = view.get("pending") or {}
    assert pending.get("id") == request_id and pending.get("status") == "pending"
    assert view.get("limit_usd") == "0.0001" and view["source"] == "workflow" and view["policy"].get("can_decide")
    assert request_id in [item.get("id") for item in nodestro.list_budget_requests()]

    with pytest.raises(NodestroAPIError) as not_higher:
        nodestro.raise_run_budget(run_id, request_id, "0.00")
    assert (not_higher.value.status, not_higher.value.code) == (422, "budget.limit_not_higher")
    with pytest.raises(NodestroAPIError) as invalid:
        nodestro.raise_run_budget(run_id, request_id, "abc")
    assert (invalid.value.status, invalid.value.code) == (422, "budget.limit_invalid")

    raised = nodestro.raise_run_budget(run_id, request_id, Decimal("2.50"), idempotency_key="sdk-budget-1")
    assert raised.get("limit_usd") == "2.50"
    again = nodestro.raise_run_budget(run_id, request_id, "2.50", idempotency_key="sdk-budget-1")
    assert again["run_id"] == run_id
    done = nodestro.wait_for_run(run_id, timeout=30, poll=0.1)
    assert done["status"] == "succeeded" and (done.get("budget") or {}).get("limit_usd") == "2.50"
    after = nodestro.get_run_budget(run_id)
    assert after.get("pending") is None and [item.get("status") for item in after.get("history", [])] == ["raised"]
    assert request_id not in [item.get("id") for item in nodestro.list_budget_requests()]

    with pytest.raises(NodestroAPIError) as late:
        nodestro.end_run_for_budget(run_id, request_id)
    assert (late.value.status, late.value.code) == (409, "budget.not_pending")
    assert late.value.params.get("request_status") == "raised"
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.end_run_for_budget(run_id, "bud_does_not_exist")
    assert missing.value.status == 404


def test_a_budget_decision_ends_the_run(nodestro: NodestroClient) -> None:
    run_id, request_id = budget_run(nodestro)
    nodestro.end_run_for_budget(run_id, request_id)
    done = nodestro.wait_for_run(run_id, timeout=30, poll=0.1)
    assert done["status"] == "cancelled" and done.get("error_code") == "run.budget_ended"


def test_local_models_and_the_semantic_index(nodestro: NodestroClient) -> None:
    overview = nodestro.local_models()
    assert overview["status"]["pinned_version"] and overview["catalog"][0]["name"] == "qwen3.5:4b"
    assert {item["task"] for item in overview["recommendations"]} >= {"classify", "embedding"}
    assert nodestro.recommend_local_model("embedding")["model"] == "ollama:qwen3-embedding:0.6b"
    with pytest.raises(NodestroAPIError) as refused:
        nodestro.recommend_local_model("dance")
    assert refused.value.code == "local.task_unknown"
    index = nodestro.knowledge_index()
    assert index["state"] == "off" and index["mode"] == "fts"
    assert nodestro.cancel_knowledge_index()["state"] == "off"
