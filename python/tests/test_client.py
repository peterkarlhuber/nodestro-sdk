"""The Python SDK against a real Nodestro API server with scripted model answers.

German values (inputs, labels, template names, the scripted answers) are deliberate test data:
Nodestro is multilingual, and the assertions look for them.
"""

from __future__ import annotations

from collections.abc import Iterator
import contextlib
from decimal import Decimal
from pathlib import Path
import socket
import threading
import time
from typing import Any
from urllib.parse import urlsplit

import pytest

from nodestro_client import (
    NodestroAPIError,
    NodestroClient,
    NodestroRunFailed,
    PublishedWorkflow,
    RetryPolicy,
    discover,
)


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
    nodestro.update_agent_template(created["id"], {"agent": {"name": "Prüfer", "system_prompt": "Prüfe genau."}})
    versions = nodestro.list_agent_template_versions(created["id"])
    assert [item["version"] for item in versions] == [2, 1]
    assert nodestro.get_agent_template_version(created["id"], 1)["agent"]["system_prompt"] == "Prüfe."
    assert nodestro.check_agent_template(created["id"])["issues"] == []
    exported = nodestro.export_agent_template(created["id"])
    assert exported["format"] == "nodestro-agent/1"
    imported = nodestro.import_agent_template(exported)
    assert imported["template"]["meta"]["origin"].startswith("import:")
    nodestro.delete_agent_template(imported["template"]["id"])
    nodestro.delete_agent_template(created["id"])
    assert created["id"] not in {item["id"] for item in nodestro.list_agent_templates()}
    assert {"calculator", "current_datetime"} <= {tool["name"] for tool in nodestro.list_tools()}


def test_library_agents_can_be_listed_and_copied(nodestro: NodestroClient) -> None:
    agents = nodestro.list_library_agents("en")
    assert "summary" in {item["id"] for item in agents}
    detail = nodestro.get_library_agent("summary", "de")
    assert detail["help"] and detail["meta"]["locale"] == "de"
    copy = nodestro.copy_library_agent("summary", language="en")
    assert copy["meta"]["origin"].startswith("builtin:") and copy["version"] == 1
    nodestro.delete_agent_template(copy["id"])


SKILL_MD = "---\nname: sdk-skill\ndescription: Checks the SDK.\n---\nStep one.\n"


def test_skills_can_be_imported_edited_exported_and_deleted(nodestro: NodestroClient) -> None:
    checked = nodestro.import_skill(SKILL_MD.encode(), filename="SKILL.md", dry_run=True)
    assert checked["skill"] is None and checked["check"]["name"] == "sdk-skill"
    skill = nodestro.create_skill({"SKILL.md": SKILL_MD, "assets/logo.bin": b"\x00\x01"}, note="first")
    assert skill["version"] == 1
    changed = nodestro.update_skill(skill["id"], {"SKILL.md": SKILL_MD + "Step two.\n", "assets/logo.bin": None})
    assert changed["version"] == 2
    assert [item["version"] for item in nodestro.list_skill_versions(skill["id"])] == [2, 1]
    detail = nodestro.get_skill(skill["id"], version=1)
    assert detail["body"].strip() == "Step one."
    assert nodestro.read_skill_file(skill["id"], 2, "SKILL.md")["text"].endswith("Step two.\n")
    assert nodestro.export_skill(skill["id"])[:2] == b"PK"
    assert nodestro.check_skill({"SKILL.md": "no front matter"})["issues"][0]["code"] == "skill.frontmatter_invalid"
    assert nodestro.set_skill_status(skill["id"], "disabled")["status"] == "disabled"
    assert nodestro.skill_usage(skill["id"]) == []
    nodestro.delete_skill(skill["id"])
    assert skill["id"] not in {item["id"] for item in nodestro.list_skills()}


def test_library_skills_can_be_listed_and_copied(nodestro: NodestroClient) -> None:
    listed = nodestro.list_library_skills("de")
    assert {item["family"] for item in listed} == {"8d-problem-solving", "research-method"}
    name = next(item["name"] for item in listed if item["family"] == "research-method")
    assert nodestro.get_library_skill(name)["body"]
    copy = nodestro.copy_library_skill(name)
    assert copy["origin"].startswith("builtin:") and copy["name"] == name
    nodestro.delete_skill(copy["id"])


def test_examples_can_be_listed_and_copied(nodestro: NodestroClient) -> None:
    examples = nodestro.list_examples("en")
    assert len(examples) >= 24  # the library grows (25 with the web research example)
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


def test_the_backend_is_discovered(nodestro: NodestroClient, server: str) -> None:
    """NAL-C1: GET /api/app names the backend to anyone and the apps only to a key with read."""
    anonymous = discover(server)
    assert anonymous.compatible and anonymous.version == 1 and anonymous.backend_id
    assert anonymous.capabilities == frozenset() and anonymous.apps == ()
    workflow = nodestro.create_workflow(simple())
    publication = nodestro.publish(workflow["id"], slug="sdk-discovered")["publication"]
    key = nodestro.create_api_key("SDK discovery", ["run", "read"], [publication["id"]])
    with PublishedWorkflow(server, publication["slug"], api_key=key["token"]) as api:
        found = api.discover()
    assert found.backend_id == anonymous.backend_id and found.supports("runs")
    assert [app["slug"] for app in found.apps] == ["sdk-discovered"]
    with pytest.raises(NodestroAPIError) as refused:
        discover(server, api_key="ndk_not_a_key")
    assert refused.value.status == 401


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


def test_result_files_of_a_run_can_be_downloaded(nodestro: NodestroClient, tmp_path: Path) -> None:
    body = simple()
    body["nodes"][2]["output"] = {"files": [{"format": "md", "name": "angebot"}]}
    workflow = nodestro.create_workflow(body)
    done = nodestro.wait_for_run(nodestro.start_run(workflow["id"], input="x")["id"], timeout=30, poll=0.1)
    files = nodestro.run_files(done["id"])
    assert [item["format"] for item in files] == ["md"]
    content = nodestro.download_file(done["id"], files[0]["id"])
    assert b"Wir liefern" in content
    assert b"".join(nodestro.stream_file(done["id"], files[0]["id"], chunk_size=7)) == content
    assert nodestro.save_file(done["id"], files[0]["id"], tmp_path / "angebot.md") == len(content)
    assert (tmp_path / "angebot.md").read_bytes() == content
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.download_file(done["id"], "file_missing")
    assert missing.value.status == 404


def test_agent_templates_can_be_updated(nodestro: NodestroClient) -> None:
    created = nodestro.create_agent_template({"agent": {"name": "Prüfer", "system_prompt": "Prüfe."}})
    changed = nodestro.update_agent_template(created["id"], {"agent": {"name": "Prüfer 2", "system_prompt": "Prüfe."}})
    assert changed["id"] == created["id"] and changed["agent"]["name"] == "Prüfer 2"
    nodestro.delete_agent_template(created["id"])


def test_examples_exist_in_all_six_languages(nodestro: NodestroClient) -> None:
    counts = {len(nodestro.list_examples(language)) for language in ("de", "en", "es", "fr", "it", "pt-BR")}
    assert len(counts) == 1 and min(counts) >= 24


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
        assert b"".join(api.stream_file(run["run_id"], str(files[0]["id"]))) == api.download(
            run["run_id"], str(files[0]["id"])
        )
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


@contextlib.contextmanager
def cutting_proxy(server: str, marker: bytes) -> Iterator[tuple[str, list[bytes]]]:
    """A TCP proxy to ``server`` that cuts its first connection right after the first event that contains
    ``marker`` reached the client (like a proxy or network that drops a stream); the others pass through.
    Yields its URL and the request heads it forwarded."""
    target = urlsplit(server)
    listener = socket.create_server(("127.0.0.1", 0))
    heads: list[bytes] = []

    def relay(client: socket.socket) -> None:
        with client, socket.create_connection((target.hostname, target.port or 80), timeout=60) as upstream:
            head = b""
            while b"\r\n\r\n" not in head:
                part = client.recv(65536)
                if not part:
                    return
                head += part
            heads.append(head)
            first = len(heads) == 1
            upstream.sendall(head)
            sent = b""
            while part := upstream.recv(65536):
                client.sendall(part)
                sent += part
                found = sent.find(marker)
                if first and found >= 0 and b"\n\n" in sent[found:]:
                    client.shutdown(socket.SHUT_RDWR)
                    return

    def accept() -> None:
        while True:
            try:
                connection, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=relay, args=(connection,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}", heads
    finally:
        listener.close()


def test_a_published_stream_cut_by_the_network_reconnects_and_misses_nothing(
    nodestro: NodestroClient, server: str
) -> None:
    """SDK-004: a real API behind a proxy that drops the stream; the client resumes with ``Last-Event-ID``."""
    body = simple("SLOW")
    body["nodes"].insert(2, agent("second", "SLOW"))
    body["edges"] = [edge("start", "writer"), edge("writer", "second"), edge("second", "out")]
    slug, token, _ = published_api(nodestro, body, "sdk-reconnect", ["run", "read"])
    with PublishedWorkflow(server, slug, api_key=token) as api:
        run = api.start({"input": "x"})
    with (
        cutting_proxy(server, b"event: node_started") as (url, heads),
        PublishedWorkflow(url, slug, api_key=token) as through,
    ):
        events = list(through.events(run["run_id"], timeout=30, reconnect=RetryPolicy(attempts=5, backoff=0.2)))
    names = [event.event for event in events]
    assert names[-1] == "end" and events[-1].data == {"status": "succeeded"}
    assert len(heads) >= 2 and b"last-event-id:" in heads[1].lower()
    # The stream broke right after a step start; still every event arrives exactly once, in order. (A step that
    # started before the first connection is only in the opening status, as the API intends.)
    steps = [f"{event.event}:{event.data['node_id']}" for event in events if event.event.startswith("node_")]
    assert len(set(steps)) == len(steps) and {"node_started:second", "node_finished:second"} <= set(steps)
    ids = [int(event.id or 0) for event in events if event.event.startswith("node_")]
    assert ids == sorted(set(ids))


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


def test_service_connections_and_the_builtin_catalog(nodestro: NodestroClient) -> None:
    catalog = {item["name"]: item for item in nodestro.list_builtin_tools()}
    spec = catalog["calculator"]["spec"]
    assert catalog["calculator"]["origin"] == "nodestro" and spec is not None and spec["offline"] is True
    assert nodestro.connection_status()["contract"] == 1
    assert {"search", "smtp", "webhook"} <= {item["name"] for item in nodestro.list_connection_types()}
    with pytest.raises(NodestroAPIError) as unsafe:
        nodestro.create_connection({"type": "webhook", "name": "Hook", "settings": {"url": "http://hooks.example.com"}})
    assert unsafe.value.status == 400 and unsafe.value.code == "connection.address_invalid"
    made = nodestro.create_connection({"type": "search", "provider": "test", "name": "SDK search"})
    assert made["secret_set"] is False and made in nodestro.list_connections(type="search")
    stored = nodestro.set_connection_secret(made["id"], "sdk-connection-secret")
    assert stored["secret_set"] is True and "sdk-connection-secret" not in str(stored)
    assert nodestro.check_connection(made["id"])["check"]["status"] == "ok"
    changed = nodestro.update_connection(made["id"], {"description": "from the SDK"})
    assert changed["description"] == "from the SDK" and nodestro.get_connection(made["id"])["secret_set"] is True
    assert "sdk-connection-secret" not in str(nodestro.list_connection_events())
    nodestro.delete_connection(made["id"])
    assert made["id"] not in {item["id"] for item in nodestro.list_connections()}


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


def test_a_save_based_on_an_old_revision_is_refused(nodestro: NodestroClient) -> None:
    """SDK-002: ``revision`` is sent as If-Match; a stale one is a 409 ``workflow.conflict``."""
    workflow = nodestro.create_workflow(simple())
    first = nodestro.update_workflow(workflow["id"], {**simple(), "name": "SDK A"}, revision=workflow["updated_at"])
    assert first["name"] == "SDK A"
    with pytest.raises(NodestroAPIError) as conflict:
        nodestro.update_workflow(workflow["id"], {**simple(), "name": "SDK B"}, revision=workflow["updated_at"])
    assert conflict.value.status == 409 and conflict.value.code == "workflow.conflict"
    assert conflict.value.params["updated_at"]
    assert nodestro.get_workflow(workflow["id"])["name"] == "SDK A"
    noted = nodestro.update_workflow(
        workflow["id"], {**simple(), "name": "SDK C"}, revision=first["updated_at"], note="renamed"
    )
    assert noted["name"] == "SDK C"
    assert nodestro.workflow_versions(workflow["id"])[0]["description"] == "renamed"
    # Without a revision the save always applies.
    assert nodestro.update_workflow(workflow["id"], {**simple(), "name": "SDK D"})["name"] == "SDK D"


def test_runs_are_paged_with_the_apis_cursor(nodestro: NodestroClient) -> None:
    """SDK-002: ``list_runs_page`` returns the ``before`` cursor, ``iter_runs`` reads every page."""
    workflow = nodestro.create_workflow(simple())
    started = [nodestro.start_run(workflow["id"], input=f"x{index}")["id"] for index in range(3)]
    for run_id in started:
        nodestro.wait_for_run(run_id, timeout=30, poll=0.1)
    page = nodestro.list_runs_page(workflow_id=workflow["id"], limit=2)
    assert [run["id"] for run in page.runs] == started[::-1][:2] and page.next_before
    rest = nodestro.list_runs(workflow_id=workflow["id"], limit=2, before=page.next_before)
    assert [run["id"] for run in rest] == [started[0]]
    last = nodestro.list_runs_page(workflow_id=workflow["id"], limit=2, before=page.next_before)
    assert last.next_before is None
    assert [run["id"] for run in nodestro.iter_runs(workflow_id=workflow["id"], page_size=1)] == started[::-1]
    assert len(list(nodestro.iter_runs(page_size=2))) >= 3


def test_the_compatibility_with_the_api_version(nodestro: NodestroClient) -> None:
    """SDK-013: ``check_compatibility`` compares ``/api/meta`` with the version the types came from."""
    from nodestro_client import API_VERSION
    from nodestro_client.client import compatibility

    found = nodestro.check_compatibility()
    assert found.compatible, found
    assert found.api_version == nodestro.meta()["version"] and found.sdk_api_version == API_VERSION
    assert compatibility("0.2.7", "0.2.0").compatible
    assert not compatibility("0.3.0", "0.2.0").compatible
    assert not compatibility("1.0.0", "0.2.0").compatible
    assert compatibility("1.4.0", "1.2.0").compatible and not compatibility("1.1.0", "1.2.0").compatible
    unreadable = compatibility("dev", "0.2.0")
    assert not unreadable.compatible and "cannot be read" in unreadable.reason


def test_a_catalog_model_is_built_from_local_files(nodestro: NodestroClient, tmp_path: Any) -> None:
    """SDK-014: ``kind="build"`` with ``template``; missing files are refused before a job starts."""
    with pytest.raises(NodestroAPIError) as partial:
        nodestro.import_local_model("build", "/no/weights", name="mdenseon:307m")
    assert partial.value.code == "local.name_missing"
    with pytest.raises(NodestroAPIError) as missing:
        nodestro.import_local_model(
            "build", str(tmp_path / "weights.safetensors"), name="mdenseon:307m", template=str(tmp_path / "t.gguf")
        )
    assert missing.value.status == 400 and missing.value.code == "local.file_missing"


def test_batches_are_planned_run_exported_and_deleted(nodestro: NodestroClient, tmp_path: Path) -> None:
    """SDK-003: one workflow over many inputs."""
    workflow = nodestro.create_workflow(simple())
    (tmp_path / "rows.csv").write_text("input\nACME\nBeta\n", encoding="utf-8")
    parsed = nodestro.parse_batch_file(workflow["id"], tmp_path / "rows.csv")
    assert parsed["columns"] == ["input"] and len(parsed["rows"]) == 2
    assert nodestro.parse_batch_file(workflow["id"], b"input\nGamma\n", filename="more.csv")["rows"] == [
        {"input": "Gamma"}
    ]
    rows = [{"input": row["input"]} for row in parsed["rows"]]
    plan = nodestro.plan_batch({"workflow_id": workflow["id"], "rows": rows})
    assert (plan["total"], plan["valid"], plan["invalid"]) == (2, 2, 0)
    batch = nodestro.create_batch({"workflow_id": workflow["id"], "rows": rows, "name": "SDK batch"})
    deadline = time.monotonic() + 60
    while (found := nodestro.get_batch(batch["id"]))["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.2)
    assert found["status"] == "finished" and [item["status"] for item in found["items"]] == ["succeeded"] * 2
    assert batch["id"] in [item["id"] for item in nodestro.list_batches()]
    assert b"ACME" in nodestro.export_batch(batch["id"])
    exported = nodestro.export_batch(batch["id"], format="json")
    assert exported.lstrip().startswith(b"[")
    with pytest.raises(ValueError, match="format"):
        nodestro.export_batch(batch["id"], format="xml")  # type: ignore[arg-type]
    with pytest.raises(NodestroAPIError) as finished:
        nodestro.pause_batch(batch["id"])
    assert (finished.value.status, finished.value.code) == (400, "batch.not_running")
    nodestro.delete_batch(batch["id"])
    with pytest.raises(NodestroAPIError) as gone:
        nodestro.get_batch(batch["id"])
    assert gone.value.status == 404


def test_schedules_are_previewed_created_changed_and_deleted(nodestro: NodestroClient) -> None:
    """SDK-003: runs at set times (created disabled; this test never lets one run)."""
    workflow = nodestro.create_workflow(simple())
    assert "Europe/Vienna" in nodestro.schedule_time_zones()
    body = {"workflow_id": workflow["id"], "name": "SDK daily", "kind": "daily", "at": "06:30", "time_zone": "UTC"}
    preview = nodestro.preview_schedule(body)
    assert isinstance(preview["ok"], bool) and preview["next_runs"]
    schedule = nodestro.create_schedule(body)
    assert schedule["enabled"] is False and schedule["at"] == "06:30"
    assert nodestro.get_schedule(schedule["id"])["name"] == "SDK daily"
    assert schedule["id"] in [item["id"] for item in nodestro.list_schedules()]
    changed = nodestro.update_schedule(schedule["id"], {**body, "kind": "weekly", "weekdays": [0]})
    assert changed["kind"] == "weekly"
    assert nodestro.preview_schedule({**body, "kind": "weekly", "weekdays": [0]}, schedule_id=schedule["id"])
    assert nodestro.disable_schedule(schedule["id"])["schedule"]["enabled"] is False
    with pytest.raises(NodestroAPIError) as bad:
        nodestro.create_schedule({**body, "time_zone": "Mars/Base"})
    assert 400 <= bad.value.status < 500
    nodestro.delete_schedule(schedule["id"])
    with pytest.raises(NodestroAPIError) as gone:
        nodestro.get_schedule(schedule["id"])
    assert gone.value.status == 404


def test_test_series_are_planned_run_compared_and_deleted(nodestro: NodestroClient) -> None:
    """SDK-003: a workflow against saved test cases."""
    workflow = nodestro.create_workflow(simple())
    suite = nodestro.create_test_series(
        {"workflow_id": workflow["id"], "name": "SDK series", "cases": [{"input": "ACME"}, {"input": "Beta"}]}
    )
    assert [case["name"] for case in suite["cases"]] == ["#1", "#2"]
    assert nodestro.get_test_series(suite["id"])["name"] == "SDK series"
    assert suite["id"] in [item["id"] for item in nodestro.list_test_series()]
    renamed = nodestro.update_test_series(suite["id"], {**suite, "name": "SDK series 2"})
    assert renamed["name"] == "SDK series 2"
    plan = nodestro.plan_test_run(suite["id"], {"judge": False})
    assert plan["cases"] == 2 and plan["judged_cases"] == 0
    first = nodestro.start_test_run(suite["id"], {"judge": False, "concurrency": 2})
    finished = nodestro.wait_for_test_run(first["id"], timeout=60, poll=0.2)
    assert finished["status"] == "finished", finished
    second = nodestro.wait_for_test_run(nodestro.start_test_run(suite["id"], {"judge": False})["id"], timeout=60)
    assert [item["id"] for item in nodestro.list_test_runs(suite["id"])] == [second["id"], first["id"]]
    comparison = nodestro.compare_test_runs(first["id"], second["id"])
    assert (comparison["a"]["id"], comparison["b"]["id"]) == (first["id"], second["id"])
    assert [case["change"] for case in comparison["cases"]] == ["same", "same"]
    choice = nodestro.test_series_model_choice(suite["id"], "writer", min_pass_rate=0.5)
    assert choice["node_id"] == "writer" and choice["suite_id"] == suite["id"]
    with pytest.raises(NodestroAPIError) as invalid_rate:
        nodestro.test_series_model_choice(suite["id"], "writer", min_pass_rate=2)
    assert invalid_rate.value.status == 422
    assert nodestro.cancel_test_run(first["id"])["status"] == "finished"  # an ended run stays as it is
    nodestro.delete_test_run(first["id"])
    with pytest.raises(NodestroAPIError) as gone:
        nodestro.get_test_run(first["id"])
    assert gone.value.status == 404
    with pytest.raises(NodestroAPIError) as empty:
        nodestro.start_test_run(nodestro.create_test_series({"workflow_id": workflow["id"], "cases": []})["id"])
    assert (empty.value.status, empty.value.code) == (400, "benchmark.no_cases")
    nodestro.delete_test_series(suite["id"])
    with pytest.raises(NodestroAPIError) as deleted:
        nodestro.get_test_series(suite["id"])
    assert deleted.value.status == 404
    with pytest.raises(NodestroAPIError) as unknown_workflow:
        nodestro.create_test_series({"workflow_id": "wf_missing", "cases": [{"input": "x"}]})
    assert 400 <= unknown_workflow.value.status < 500


def test_knowledge_files_are_uploaded_searched_changed_and_deleted(nodestro: NodestroClient, tmp_path: Path) -> None:
    """SDK-003: the knowledge base."""
    (tmp_path / "returns.md").write_text("# Returns\n\nGoods can be returned within 30 days.", encoding="utf-8")
    added = nodestro.upload_knowledge(
        [tmp_path / "returns.md", ("shipping.md", b"# Shipping\n\nWe ship to Austria in two days.")],
        description="SDK policies",
        collection="sdk-policies",
    )
    assert [item["name"] for item in added] == ["returns.md", "shipping.md"]
    ids = [item["id"] for item in added]
    assert {item["id"] for item in nodestro.list_knowledge("SDK policies")} >= set(ids)
    assert "sdk-policies" in [item["name"] for item in nodestro.knowledge_collections()]
    hits = nodestro.search_knowledge("returned", mode="fts")
    assert hits and hits[0]["file_id"] == ids[0]
    assert nodestro.search_knowledge("returned", file_ids=[ids[1]], mode="fts") == []
    assert b"30 days" in nodestro.knowledge_content(ids[0])
    changed = nodestro.update_knowledge(ids[0], description="Returns policy", collection="sdk-other")
    assert (changed["description"], changed["collection"]) == ("Returns policy", "sdk-other")
    with pytest.raises(NodestroAPIError) as invalid:
        nodestro.search_knowledge("x", k=500)
    assert invalid.value.status == 422
    with pytest.raises(ValueError, match="at least one"):
        nodestro.upload_knowledge([])
    with pytest.raises(TypeError):
        nodestro.upload_knowledge(tmp_path / "returns.md")  # type: ignore[arg-type]
    for file_id in ids:
        nodestro.delete_knowledge(file_id)
    with pytest.raises(NodestroAPIError) as gone:
        nodestro.knowledge_content(ids[0])
    assert gone.value.status == 404


def test_input_files_are_uploaded_read_and_cleaned_up(nodestro: NodestroClient) -> None:
    """SDK-003: files for runs."""
    formats = nodestro.input_formats()
    assert formats
    before = nodestro.input_storage()
    results = nodestro.upload_inputs([("order.txt", b"10 pieces until Friday"), ("tool.exe", b"MZ")], accept=".txt")
    assert results[0]["file"] is not None and results[0].get("problem") in (None, {})
    assert results[1].get("file") is None and results[1]["problem"]
    stored = results[0]["file"]
    assert stored is not None
    assert nodestro.get_input(stored["id"])["name"] == "order.txt"
    assert "10 pieces" in nodestro.input_text(stored["id"])["text"]
    assert nodestro.input_content(stored["id"]) == b"10 pieces until Friday"
    assert nodestro.input_storage()["files"] == before["files"] + 1
    run = nodestro.start_run(nodestro.create_workflow(simple())["id"], input="Read it", file_ids=[stored["id"]])
    nodestro.wait_for_run(run["id"], timeout=60)
    unused = nodestro.upload_inputs([("unused.txt", b"nobody reads this")])[0]["file"]
    assert unused is not None
    nodestro.clean_up_inputs()  # a new file and the file of a finished run stay
    assert nodestro.get_input(unused["id"]) and nodestro.get_input(stored["id"])
    with pytest.raises(NodestroAPIError) as in_use:
        nodestro.delete_input(stored["id"])
    assert in_use.value.code == "input.in_use" and 400 <= in_use.value.status < 500
    nodestro.delete_input(unused["id"])
    cleaned = nodestro.clean_up_inputs(older_than_days=0)  # also the files of finished runs
    assert cleaned["removed"] >= 1 and cleaned["freed_bytes"] >= len(b"10 pieces until Friday")
    for file_id in (stored["id"], unused["id"]):
        with pytest.raises(NodestroAPIError) as gone:
            nodestro.get_input(file_id)
        assert gone.value.status == 404


def test_tool_approvals_are_read_and_decided_only_where_switched_on(nodestro: NodestroClient) -> None:
    """SDK-003: per-call tool approvals. The test server keeps NODESTRO_TOOL_APPROVALS off (the default), so there
    are no questions; the methods answer and refuse unknown ones."""
    assert nodestro.list_tool_approvals() == []
    run = nodestro.start_run(nodestro.create_workflow(simple())["id"], input="go")
    assert nodestro.run_tool_approvals(run["id"]) == []
    assert isinstance(nodestro.tool_approval_audit(limit=10), list)
    with pytest.raises(NodestroAPIError) as unknown:
        nodestro.decide_tool_approval(run["id"], "tap_missing", "approved", arguments_hash="0" * 64)
    assert unknown.value.status in (404, 409)
    with pytest.raises(ValueError, match="decision"):
        nodestro.decide_tool_approval(run["id"], "tap_missing", "maybe", arguments_hash="x")  # type: ignore[arg-type]


def test_exports_are_checked_built_downloaded_and_deleted(nodestro: NodestroClient, tmp_path: Path) -> None:
    """SDK-003: standalone exports of a publication; portable packages are export jobs (their build downloads
    Python and libraries, so this test only checks how a job is refused and looked up)."""
    import io
    import zipfile

    workflow = nodestro.create_workflow(simple())
    publication = nodestro.publish(workflow["id"], slug=f"sdk-export-{int(time.time() * 1000)}")["publication"]
    check = nodestro.check_export(publication["id"])
    assert check["ok"] is True
    record = nodestro.create_export(publication["id"], {"kind": "standard"})
    assert record["publication_id"] == publication["id"] and record["size"] > 0
    assert nodestro.list_exports(publication["id"])[0]["id"] == record["id"]
    data = nodestro.download_export(record["id"])
    assert len(data) == record["size"] and zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert nodestro.save_export(record["id"], tmp_path / "export.zip") == record["size"]
    assert (tmp_path / "export.zip").read_bytes() == data
    with pytest.raises(NodestroAPIError) as standard_job:
        nodestro.start_export_job(publication["id"], {"kind": "standard"})
    assert (standard_job.value.status, standard_job.value.code) == (400, "export.not_portable")
    assert nodestro.list_export_jobs(publication["id"]) == []
    for call in (nodestro.get_export_job, nodestro.cancel_export_job):
        with pytest.raises(NodestroAPIError) as missing:
            call("xjob_missing")
        assert missing.value.status == 404
    nodestro.delete_export(record["id"])
    with pytest.raises(NodestroAPIError) as gone:
        nodestro.download_export(record["id"])
    assert gone.value.status == 404
