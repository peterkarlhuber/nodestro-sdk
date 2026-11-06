"""Retries, timeouts, error formats and the event-stream parser (no server needed)."""

from __future__ import annotations

from collections.abc import Iterator
import contextlib
from decimal import Decimal
import json
from pathlib import Path
import socket
import time
from typing import Any

import httpx
import pytest

from nodestro_client import (
    NodestroAPIError,
    NodestroClient,
    NodestroClientError,
    NodestroConnectionError,
    NodestroTimeoutError,
    PublishedWorkflow,
    RetryPolicy,
)
from nodestro_client._http import parse_events

FAST = RetryPolicy(attempts=3, backoff=0.001)


def client_with(handler: Any) -> NodestroClient:
    http = httpx.Client(base_url="http://nodestro.test", transport=httpx.MockTransport(handler))
    return NodestroClient("http://nodestro.test", retry=FAST, http_client=http)


def published_with(handler: Any, api_key: str = "ndk_test", **options: Any) -> PublishedWorkflow:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return PublishedWorkflow("http://nodestro.test", "slug", api_key=api_key, http_client=http, **options)


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
        client_with(handler).create_workflow({"name": "x", "nodes": [], "edges": []})
    assert calls == ["POST"] and raised.value.status == 503


def test_starting_a_run_is_retried_with_one_idempotency_key() -> None:
    """API2-08: every start carries an Idempotency-Key, so a retry cannot start the run twice."""
    keys: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers.get("idempotency-key"))
        if len(keys) < 2:
            return httpx.Response(503)
        return httpx.Response(201, json={"id": "run_1", "status": "queued"})

    assert client_with(handler).start_run("wf_1", input="x")["id"] == "run_1"
    assert len(keys) == 2 and keys[0] and keys[0] == keys[1]
    keys.clear()
    client_with(handler).start_run("wf_1", input="x", idempotency_key="order-7")
    assert keys == ["order-7", "order-7"]


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


def test_ids_are_encoded_as_single_path_segments() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.raw_path.decode())
        return httpx.Response(200, json={})

    client_with(handler).get_run("../workflows?x=1#y")
    published = PublishedWorkflow(
        "http://nodestro.test",
        "angebot/x",
        api_key="ndk_test",
        retry=FAST,
        http_client=httpx.Client(base_url="http://nodestro.test", transport=httpx.MockTransport(handler)),
    )
    published.status("run 1")
    # Like encodeURIComponent in the TypeScript SDK: an id never changes which endpoint is called.
    assert paths == ["/api/runs/..%2Fworkflows%3Fx%3D1%23y", "/api/published/angebot%2Fx/runs/run%201"]


# ---- ids, base URLs and configuration --------------------------------------------------------


@pytest.mark.parametrize("bad", ["", ".", ".."])
def test_ids_that_url_normalization_would_change_are_refused(bad: str) -> None:
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.url.path)
        return httpx.Response(200, json={})

    client = client_with(handler)
    published = PublishedWorkflow("http://nodestro.test", "slug", api_key="ndk_test", http_client=client._http.client)
    for call in (
        lambda: client.get_run(bad),
        lambda: client.get_workflow(bad),
        lambda: client.download_file("run_1", bad),
        lambda: client.decide_approval("run_1", bad, "approved"),
        lambda: client.get_run_budget(bad),
        lambda: client.end_run_for_budget(bad, "bud_1"),
        lambda: client.copy_example(bad),
        lambda: published.status(bad),
        lambda: published.download("run_1", bad),
        lambda: PublishedWorkflow("http://nodestro.test", bad, api_key="ndk_test"),
    ):
        with pytest.raises(ValueError, match="not a valid id"):
            call()
    assert sent == []
    # Dots inside an id are ordinary characters.
    client.get_run("run.1..x")
    assert sent == ["/api/runs/run.1..x"]


@pytest.mark.parametrize(
    ("given", "url"),
    [
        ("http://127.0.0.1:8000/", "http://127.0.0.1:8000/api/meta"),
        ("https://nodestro.example.com", "https://nodestro.example.com/api/meta"),
        ("http://[::1]:8060", "http://[::1]:8060/api/meta"),
        ("https://proxy.example.com/nodestro/", "https://proxy.example.com/nodestro/api/meta"),
    ],
)
def test_base_urls(given: str, url: str) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"version": "0.2.0"})

    # A client without base_url: the SDK builds absolute URLs itself.
    http = httpx.Client(transport=httpx.MockTransport(handler))
    NodestroClient(given, http_client=http).meta()
    assert seen == [url]


@pytest.mark.parametrize(
    "bad", ["127.0.0.1:8000", "ftp://host", "http://", "http://host/?x=1", "http://host/#a", "http://user:pw@host"]
)
def test_invalid_base_urls_are_refused(bad: str) -> None:
    with pytest.raises(ValueError, match="base URL"):
        NodestroClient(bad)


@pytest.mark.parametrize(
    "policy",
    [
        {"attempts": 0},
        {"attempts": -1},
        {"attempts": 1.5},
        {"attempts": True},
        {"backoff": -1},
        {"backoff": float("nan")},
        {"max_backoff": float("inf")},
    ],
)
def test_invalid_retry_policies_are_refused(policy: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="RetryPolicy"):
        RetryPolicy(**policy)


def test_one_attempt_means_no_retry_and_long_backoffs_do_not_overflow() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(503, text="busy")

    http = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(NodestroAPIError) as raised:
        NodestroClient("http://nodestro.test", retry=RetryPolicy(attempts=1), http_client=http).meta()
    assert calls == ["GET"] and raised.value.status == 503
    assert 0 < RetryPolicy(max_backoff=8).delay(5000) <= 10


@pytest.mark.parametrize("timeout", [0, -1, float("nan"), float("inf")])
def test_invalid_timeouts_are_refused(timeout: float) -> None:
    with pytest.raises(ValueError, match="timeout"):
        NodestroClient("http://nodestro.test", timeout=timeout)


def test_an_empty_api_key_is_refused() -> None:
    for key in ("", "  ", "ndk_x\r\nX-Evil: 1"):
        with pytest.raises(ValueError, match="api_key"):
            PublishedWorkflow("http://nodestro.test", "slug", api_key=key)


# ---- headers and a shared httpx client ---------------------------------------------------------


def test_a_shared_http_client_keeps_its_headers_and_each_key_stays_with_its_client() -> None:
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("authorization")))
        return httpx.Response(200, json={"name": "x"})

    shared = httpx.Client(transport=httpx.MockTransport(handler), headers={"X-App": "mine"})
    first = PublishedWorkflow("http://nodestro.test", "one", api_key="ndk_one", http_client=shared)
    second = PublishedWorkflow("http://nodestro.test", "two", api_key="ndk_two", http_client=shared)
    first.info()
    second.info()
    shared.get("http://elsewhere.test/")
    assert seen == [
        ("/api/published/one", "Bearer ndk_one"),
        ("/api/published/two", "Bearer ndk_two"),
        ("/", None),  # the key never became a default header of the caller's client
    ]
    assert "authorization" not in shared.headers and shared.headers["x-app"] == "mine"
    first.close()
    second.close()
    assert not shared.is_closed  # owned by the caller


def test_custom_headers_are_sent_with_every_request() -> None:
    seen: list[tuple[list[str], str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.headers.get_list("authorization"), request.headers.get("x-trace")))
        return httpx.Response(200, json={})

    with NodestroClient(
        "http://nodestro.test",
        headers={"authorization": "Bearer proxy", "X-Trace": "1"},
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    ) as client:
        client.meta()
        client.get_run("run_1")
    assert seen == [(["Bearer proxy"], "1")] * 2


def test_the_owned_client_is_closed_once_and_twice_is_harmless() -> None:
    client = NodestroClient("http://nodestro.test")
    client.close()
    client.close()
    assert client._http.client.is_closed


# ---- answers that are not what they should be -------------------------------------------------


def test_redirects_are_not_followed_and_the_key_stays_here() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(307, headers={"Location": "https://elsewhere.test/api/published/slug"})

    api = PublishedWorkflow(
        "http://nodestro.test",
        "slug",
        api_key="ndk_secret",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(NodestroAPIError) as raised:
        api.info()
    assert raised.value.status == 307 and raised.value.code == "http_redirect"
    assert "elsewhere.test" in raised.value.message and "ndk_secret" not in str(raised.value)
    assert seen == ["http://nodestro.test/api/published/slug"]


def test_an_answer_that_is_no_json_is_a_client_error() -> None:
    client = client_with(
        lambda _request: httpx.Response(200, text="<html>Studio</html>", headers={"Content-Type": "text/html"})
    )
    with pytest.raises(NodestroClientError, match="not JSON") as raised:
        client.meta()
    assert not isinstance(raised.value, NodestroAPIError)


@pytest.mark.parametrize(
    ("body", "code", "params"),
    [
        ({"error": {"code": "auth.scope", "message": "No", "params": ["x"]}}, "auth.scope", {}),
        ({"detail": "Nope", "code": "x.y", "params": "text"}, "x.y", {}),
        ({"detail": None}, "error", {}),
        ({"error": "plain"}, "http_error", {}),
        ([1, 2], "http_error", {}),
        ("text", "http_error", {}),
    ],
)
def test_malformed_error_bodies_still_become_api_errors(body: Any, code: str, params: dict[str, Any]) -> None:
    error = NodestroAPIError.from_response(418, body, json.dumps(body))
    assert (error.status, error.code, error.params) == (418, code, params)


def test_error_pages_of_proxies_keep_status_and_a_short_text() -> None:
    page = "<html><body>" + "Bad Gateway " * 200 + "</body></html>"
    client = client_with(lambda _request: httpx.Response(502, text=page, headers={"Content-Type": "text/html"}))
    with pytest.raises(NodestroAPIError) as raised:
        client.meta()
    assert raised.value.status == 502 and raised.value.code == "http_error" and len(raised.value.message) == 500
    empty = client_with(lambda _request: httpx.Response(500))
    with pytest.raises(NodestroAPIError, match="HTTP 500"):
        empty.meta()


def test_connection_errors_do_not_contain_the_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    api = PublishedWorkflow(
        "http://nodestro.test",
        "slug",
        api_key="ndk_secret",
        retry=FAST,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(NodestroConnectionError) as raised:
        api.info()
    assert "ndk_secret" not in str(raised.value) and "ndk_secret" not in repr(raised.value.__cause__)


# ---- idempotent starts and waiting ------------------------------------------------------------


def test_a_start_is_retried_with_the_same_idempotency_key_and_waits_longer() -> None:
    seen: list[tuple[str | None, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.headers.get("idempotency-key"), request.extensions["timeout"]["read"]))
        if len(seen) == 1:
            raise httpx.ReadError("connection reset", request=request)
        if len(seen) == 2:
            return httpx.Response(504, text="gateway timeout")
        return httpx.Response(200, json={"run_id": "run_1", "status": "running"})

    api = PublishedWorkflow(
        "http://nodestro.test",
        "slug",
        api_key="ndk_test",
        timeout=10,
        retry=FAST,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert api.start({"input": "x"}, wait=20)["run_id"] == "run_1"
    keys = {key for key, _ in seen}
    assert len(seen) == 3 and len(keys) == 1 and len(next(iter(keys)) or "") == 32
    assert {read for _, read in seen} == {30}  # the request may take the wait plus the usual limit
    seen.clear()
    api.start({"input": "x"}, idempotency_key="mine")
    api.start({"input": "x"})
    assert seen[-3][0] == "mine" and seen[-1][0] not in (None, "mine", next(iter(keys)))
    with pytest.raises(ValueError, match="wait"):
        api.start({"input": "x"}, wait=-1)


def test_a_run_chat_message_is_retried_with_the_same_client_id() -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            raise httpx.ReadError("connection reset", request=request)
        if len(bodies) == 2:
            return httpx.Response(503, text="busy")
        return httpx.Response(201, json={**bodies[-1], "id": "msg_1", "run_id": "run_1", "status": "queued"})

    client = client_with(handler)
    message = {"kind": "instruction", "target_run_id": "run_1", "node_id": "lead", "content": "Kürzer"}
    assert client.send_run_chat_message("run_1", **message)["id"] == "msg_1"  # type: ignore[arg-type]
    keys = {body["client_id"] for body in bodies}
    assert len(bodies) == 3 and len(keys) == 1 and len(next(iter(keys))) == 32
    assert all(body["content"] == "Kürzer" and body["kind"] == "instruction" for body in bodies)
    bodies.clear()
    client.send_run_chat_message("run_1", **message, client_id="tab-1")  # type: ignore[arg-type]
    client.send_run_chat_message("run_1", **message)  # type: ignore[arg-type]
    assert bodies[2]["client_id"] == "tab-1" and bodies[-1]["client_id"] not in ("tab-1", *keys)


def test_waiting_ends_at_the_timeout_even_with_a_long_poll_interval() -> None:
    client = client_with(lambda _request: httpx.Response(200, json={"id": "run_1", "status": "running"}))
    began = time.monotonic()
    with pytest.raises(NodestroTimeoutError, match="still running"):
        client.wait_for_run("run_1", timeout=0.3, poll=30)
    assert time.monotonic() - began < 5
    for poll, timeout in ((0, 1), (-1, 1), (float("nan"), 1), (1, -1), (1, float("inf"))):
        with pytest.raises(ValueError):
            client.wait_for_run("run_1", timeout=timeout, poll=poll)
    paused = client_with(lambda _request: httpx.Response(200, json={"id": "run_1", "status": "paused"}))
    assert paused.wait_for_run("run_1", timeout=0)["status"] == "paused"


def test_each_status_request_of_a_wait_gets_the_time_that_is_left() -> None:
    """SDK-004: the whole wait keeps to ``timeout``: a status request is limited to the time left (at least 0.5 s),
    never the client's longer request timeout; the published client does the same."""
    limits: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        limits.append(request.extensions["timeout"]["read"])
        return httpx.Response(200, json={"id": "run_1", "run_id": "run_1", "status": "running"})

    http = httpx.Client(base_url="http://nodestro.test", transport=httpx.MockTransport(handler))
    client = NodestroClient("http://nodestro.test", retry=FAST, http_client=http, timeout=60)
    with pytest.raises(NodestroTimeoutError):
        client.wait_for_run("run_1", timeout=2, poll=0.6)
    assert len(limits) >= 2 and limits[0] <= 2 and all(0.5 <= limit < limits[0] for limit in limits[1:])
    limits.clear()
    with pytest.raises(NodestroTimeoutError):
        published_with(handler, timeout=60).wait("run_1", timeout=1, poll=0.4)
    assert limits and all(0.5 <= limit <= 1 for limit in limits)


# ---- event streams ----------------------------------------------------------------------------


def test_an_event_without_its_closing_blank_line_is_dropped() -> None:
    lines = ["event: snapshot", "data: {}", "", "event: end", 'data: {"status": "succ']
    assert [event.event for event in parse_events(iter(lines))] == ["snapshot"]
    assert [event.event for event in parse_events(iter([*lines[:4], "data: {}"]))] == ["snapshot"]


def test_event_ids_with_a_null_character_are_ignored_and_lines_without_colon_are_fields() -> None:
    lines = ["id: 1", "data", "", "id: 2\0", "data: x", ""]
    events = list(parse_events(iter(lines)))
    assert [(item.id, item.data) for item in events] == [("1", ""), ("1", "x")]


def test_events_send_last_event_id_and_report_errors_and_stalls() -> None:
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("last-event-id"))
        if request.url.path.endswith("missing/events"):
            return httpx.Response(404, json={"error": {"code": "run.not_found", "message": "No"}})
        if request.url.path.endswith("stalled/events"):
            raise httpx.ReadTimeout("stalled", request=request)
        return httpx.Response(
            200, text="id: 8\nevent: end\ndata: {}\n\n", headers={"Content-Type": "text/event-stream"}
        )

    api = PublishedWorkflow(
        "http://nodestro.test",
        "slug",
        api_key="ndk_test",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert [(e.event, e.id) for e in api.events("run_1", last_event_id="7", timeout=5)] == [("end", "8")]
    assert seen == ["7"]
    with pytest.raises(NodestroAPIError) as missing:
        list(api.events("missing"))
    assert missing.value.code == "run.not_found"
    with pytest.raises(NodestroTimeoutError):
        list(api.events("stalled"))


def test_leaving_an_event_loop_early_closes_the_stream() -> None:
    closed: list[bool] = []

    class Stream(httpx.SyncByteStream):
        def __iter__(self) -> Iterator[bytes]:
            yield b"event: snapshot\ndata: {}\n\n"
            yield b": keep-alive\n\n" * 10

        def close(self) -> None:
            closed.append(True)

    client = client_with(lambda _request: httpx.Response(200, stream=Stream()))
    with contextlib.closing(client.events("run_1")) as events:
        assert next(events).event == "snapshot"
    assert closed == [True]


# ---- run budgets ------------------------------------------------------------------------------

BUDGET = {"run_id": "run_1", "status": "running", "source": "workflow", "spent_usd": "0.0001", "policy": {}}


def test_budget_views_and_requests_are_read_from_their_routes() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(f"{request.method} {request.url.raw_path.decode()}")
        if request.url.path == "/api/budget-requests":
            return httpx.Response(200, json=[{"id": "bud_1", "limit_usd": "0.10", "spent_usd": "0.0999"}])
        return httpx.Response(200, json={**BUDGET, "limit_usd": "0.10", "remaining_usd": "0.0001"})

    client = client_with(handler)
    view = client.get_run_budget("run_1")
    # Amounts stay the decimal strings the API sent.
    assert (view["limit_usd"], view["remaining_usd"], view["spent_usd"]) == ("0.10", "0.0001", "0.0001")
    assert [item["limit_usd"] for item in client.list_budget_requests()] == ["0.10"]
    assert seen == ["GET /api/runs/run_1/budget", "GET /api/budget-requests?status=pending"]


def test_budget_decisions_send_amounts_as_decimal_strings() -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/runs/run_1/budget/decisions"
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={**BUDGET, "limit_usd": bodies[-1].get("limit_usd")})

    client = client_with(handler)
    assert client.raise_run_budget("run_1", "bud_1", "2.50")["limit_usd"] == "2.50"
    client.raise_run_budget("run_1", "bud_1", Decimal("2.50"))
    client.raise_run_budget("run_1", "bud_1", Decimal("1E+1"))
    client.decide_run_budget("run_1", "bud_1", "raise", limit_usd="0.30")
    client.end_run_for_budget("run_1", "bud_1")
    assert [body.get("limit_usd") for body in bodies] == ["2.50", "2.50", "10", "0.30", None]
    assert [body["action"] for body in bodies] == ["raise", "raise", "raise", "raise", "end"]
    assert all(body["request_id"] == "bud_1" for body in bodies) and "limit_usd" not in bodies[-1]
    for wrong in (2.5, 3, None):
        with pytest.raises(TypeError, match="decimal string"):
            client.raise_run_budget("run_1", "bud_1", wrong)  # type: ignore[arg-type]
    assert len(bodies) == 5


def test_a_budget_decision_is_retried_with_the_same_idempotency_key() -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            raise httpx.ReadError("connection reset", request=request)
        if len(bodies) == 2:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, json=BUDGET)

    client = client_with(handler)
    assert client.raise_run_budget("run_1", "bud_1", "2.50")["run_id"] == "run_1"
    keys = {body["idempotency_key"] for body in bodies}
    assert len(bodies) == 3 and len(keys) == 1 and len(next(iter(keys))) == 32
    bodies.clear()
    client.raise_run_budget("run_1", "bud_1", "2.50", idempotency_key="decision-1")
    client.end_run_for_budget("run_1", "bud_1", idempotency_key="decision-2")
    client.end_run_for_budget("run_1", "bud_1")
    assert [body["idempotency_key"] for body in bodies[2:4]] == ["decision-1", "decision-2"]
    assert bodies[-1]["idempotency_key"] not in ("decision-1", "decision-2", *keys)


@pytest.mark.parametrize(
    ("status", "code", "params"),
    [
        (409, "budget.not_pending", {"request_status": "raised", "decided_by": "local"}),
        (422, "budget.limit_not_higher", {"current_limit_usd": "0.10"}),
        (422, "budget.limit_invalid", {"value": "abc"}),
        (403, "budget.over_policy", {"max_limit_usd": "1.00"}),
        (403, "access.forbidden", {"reason": "budget.not_starter"}),
    ],
)
def test_budget_refusals_keep_status_code_and_params(status: int, code: str, params: dict[str, Any]) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(status, json={"detail": "refused", "code": code, "params": params})

    with pytest.raises(NodestroAPIError) as refused:
        client_with(handler).raise_run_budget("run_1", "bud_1", "5")
    assert (refused.value.status, refused.value.code, refused.value.params) == (status, code, params)
    assert calls == ["POST"]  # a refusal is an answer, never retried


def test_waiting_returns_at_a_budget_decision() -> None:
    run = {"id": "run_1", "status": "paused", "budget": {"limit_usd": "0.10", "pending_request_id": "bud_1"}}
    client = client_with(lambda _request: httpx.Response(200, json=run))
    paused = client.wait_for_run("run_1", timeout=1)
    assert paused["status"] == "paused" and (paused.get("budget") or {}).get("pending_request_id") == "bud_1"


def test_requests_name_the_sdk_and_its_version() -> None:
    """API2-14: ``User-Agent: nodestro-sdk-python/<version>``; the caller's own wins."""
    from nodestro_client import __version__

    agents: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        agents.append(request.headers.get("user-agent"))
        return httpx.Response(200, json={"version": "0.2.0", "publication": "slug"})

    client_with(handler).meta()
    published_with(handler).info()
    assert agents == [f"nodestro-sdk-python/{__version__}"] * 2 and __version__ != "0.0.0"
    agents.clear()
    mine = httpx.Client(transport=httpx.MockTransport(handler))
    NodestroClient("http://nodestro.test", headers={"User-Agent": "my-tool/1"}, http_client=mine).meta()
    shared = httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": "shared/2"})
    NodestroClient("http://nodestro.test", http_client=shared).meta()
    assert agents == ["my-tool/1", "shared/2"]


def test_batch_files_are_sent_as_multipart_and_batches_are_never_started_twice() -> None:
    """SDK-003: parse_batch_file takes a path, bytes or a file object; create_batch is not retried."""
    import io

    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/batches":
            return httpx.Response(503)
        return httpx.Response(200, json={"columns": ["a"], "rows": [{"a": "1"}], "mapping": {}})

    client = client_with(handler)
    upload = io.BytesIO(b"a\n1\n")
    upload.name = "/tmp/rows.xlsx"
    client.parse_batch_file("wf 1", upload)
    body = seen[-1].read()
    assert b'filename="rows.xlsx"' in body and b"wf 1" in body and b"a\n1\n" in body
    client.parse_batch_file("wf_1", b"a\n1\n")
    assert b'filename="rows.csv"' in seen[-1].read()
    with pytest.raises(NodestroAPIError):
        client.create_batch({"workflow_id": "wf_1", "rows": [{"input": "x"}]})
    assert [request.url.path for request in seen].count("/api/batches") == 1
