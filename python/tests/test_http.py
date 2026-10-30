"""Retries, timeouts, error formats and the event-stream parser (no server needed)."""

from __future__ import annotations

from collections.abc import Iterator
import contextlib
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
