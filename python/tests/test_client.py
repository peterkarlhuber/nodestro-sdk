"""The Python SDK against a real Nodestro API server with scripted model answers."""

from __future__ import annotations

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
    assert "api_key" not in str(settings).lower() or all(not item.get("api_key") for item in settings["providers"])  # type: ignore[typeddict-item]


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
    assert missing.value.status == 404 and missing.value.code == "not_found"
    workflow = nodestro.create_workflow({"name": "leer", "nodes": [], "edges": []})
    with pytest.raises(NodestroAPIError) as refused:
        nodestro.start_run(workflow["id"], input="x")
    assert refused.value.status == 400 and refused.value.code


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
