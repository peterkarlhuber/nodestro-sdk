"""Retries, timeouts, error formats and the event-stream parser (no server needed)."""

from __future__ import annotations

import json
from pathlib import Path
import socket
from typing import Any

import httpx
import pytest

from nodestro_client import NodestroAPIError, NodestroClient, NodestroConnectionError, RetryPolicy
from nodestro_client._http import parse_events

FAST = RetryPolicy(attempts=3, backoff=0.001)


def client_with(handler: Any) -> NodestroClient:
    http = httpx.Client(base_url="http://nodestro.test", transport=httpx.MockTransport(handler))
    return NodestroClient("http://nodestro.test", retry=FAST, http_client=http)


def test_reads_are_retried_after_503() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(503) if len(calls) < 3 else httpx.Response(200, json={"version": "0.2.0"})

    assert client_with(handler).meta()["version"] == "0.2.0"
    assert calls == ["GET", "GET", "GET"]


def test_changes_are_never_sent_twice() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(503, json={"detail": "busy", "code": "busy", "params": {}})

    with pytest.raises(NodestroAPIError) as raised:
        client_with(handler).start_run("wf_1", input="x")
    assert calls == ["POST"] and raised.value.status == 503


def test_both_error_formats_become_one_exception() -> None:
    studio = NodestroAPIError.from_response(
        400, {"detail": "nope", "code": "run.agents_invalid", "params": {"agents": "A"}}
    )
    assert (studio.code, studio.message, studio.params) == ("run.agents_invalid", "nope", {"agents": "A"})
    published = NodestroAPIError.from_response(
        429, {"error": {"status": 429, "code": "limit.daily_budget", "message": "Limit", "params": {"limit": 5}}}
    )
    assert (published.status, published.code, published.params) == (429, "limit.daily_budget", {"limit": 5})
    plain = NodestroAPIError.from_response(500, None, "Internal Server Error")
    assert plain.code == "http_error" and "Internal" in plain.message


def test_an_unreachable_server_is_a_connection_error() -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with (
        NodestroClient(f"http://127.0.0.1:{port}", retry=FAST, timeout=2) as client,
        pytest.raises(NodestroConnectionError),
    ):
        client.meta()


def test_event_stream_parsing() -> None:
    lines = [
        ": keep-alive",
        "event: snapshot",
        'data: {"id": "run_1",',
        'data:  "status": "running"}',
        "id: 3",
        "",
        "event: end",
        "data: {}",
        "",
    ]
    events = list(parse_events(iter(lines)))
    # The last event id stays until the server sends another one (as in browsers).
    assert [(item.event, item.id) for item in events] == [("snapshot", "3"), ("end", "3")]
    assert events[0].data == {"id": "run_1", "status": "running"}


def test_the_models_belong_to_the_committed_api_contract() -> None:
    # nodestro_client/models.py is generated from this document (make generate); both are committed.
    document = json.loads((Path(__file__).resolve().parents[2] / "openapi" / "nodestro-api.json").read_text())
    models = (Path(__file__).resolve().parents[1] / "src" / "nodestro_client" / "models.py").read_text()
    for name in ("Run", "RunIn", "RunStatusOut", "ApprovalDecision", "ResumeRequest", "InfoOut"):
        assert name in document["components"]["schemas"]
        assert f"class {name}(TypedDict" in models
