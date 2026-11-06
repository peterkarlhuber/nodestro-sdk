"""Reconnecting event streams and streamed downloads (SDK-004), without a Nodestro server.

The failure paths run against two kinds of doubles: ``httpx.MockTransport`` streams that raise the
errors httpx raises, and small real HTTP servers on 127.0.0.1 that break their connections, so the
errors come from httpx itself.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
from pathlib import Path
import threading
import time
from typing import Any, ClassVar

import httpx
import pytest

from nodestro_client import (
    DEFAULT_RECONNECT,
    NodestroAPIError,
    NodestroClient,
    NodestroConnectionError,
    NodestroTimeoutError,
    PublishedWorkflow,
    RetryPolicy,
    _http,
)

FAST = RetryPolicy(attempts=3, backoff=0.001)
SSE = {"Content-Type": "text/event-stream"}


class Broken(httpx.SyncByteStream):
    """A body that sends ``chunks`` and then fails with ``error`` (``None``: ends normally)."""

    def __init__(self, chunks: list[bytes], error: Exception | None = None) -> None:
        self.chunks = chunks
        self.error = error
        self.pulled = 0
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self.chunks:
            self.pulled += 1
            yield chunk
        if self.error is not None:
            raise self.error

    def close(self) -> None:
        self.closed = True


def published(handler: Callable[[httpx.Request], httpx.Response], **options: Any) -> PublishedWorkflow:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return PublishedWorkflow("http://nodestro.test", "slug", api_key="ndk_test", http_client=http, **options)


def studio(handler: Callable[[httpx.Request], httpx.Response]) -> NodestroClient:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return NodestroClient("http://nodestro.test", retry=FAST, http_client=http)


def scripted(answers: list[Callable[[httpx.Request], httpx.Response]]) -> tuple[Any, list[httpx.Request]]:
    """A handler that gives the answers in order (the last one repeats) and records the requests."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answers[min(len(seen), len(answers)) - 1](request)

    return handler, seen


def drop(request: httpx.Request) -> httpx.ReadError:
    return httpx.ReadError("connection reset by peer", request=request)


def status_then_drop(request: httpx.Request) -> httpx.Response:
    """An answer that sends the opening ``status`` event and then loses its connection."""
    return httpx.Response(200, headers=SSE, stream=Broken([b"event: status\ndata: {}\n\n"], drop(request)))


# ---- reconnecting event streams ---------------------------------------------------------------


def test_a_dropped_published_stream_resumes_with_the_last_event_id() -> None:
    def first(request: httpx.Request) -> httpx.Response:
        body = [b'id: 1\nevent: status\ndata: {"status": "running"}\n\n', b"id: 2\nevent: node_started\ndata: {}\n\n"]
        return httpx.Response(200, headers=SSE, stream=Broken(body, drop(request)))

    def second(_request: httpx.Request) -> httpx.Response:
        body = b'event: status\ndata: {"status": "running"}\n\nid: 3\nevent: node_finished\ndata: {}\n\n'
        return httpx.Response(200, headers=SSE, content=body + b'event: end\ndata: {"status": "succeeded"}\n\n')

    handler, seen = scripted([first, second])
    stream = published(handler).events("run_1", reconnect=RetryPolicy(attempts=3, backoff=0.001))
    got = [(event.event, event.id) for event in stream]
    assert got == [("status", "1"), ("node_started", "2"), ("status", None), ("node_finished", "3"), ("end", "3")]
    assert [request.headers.get("last-event-id") for request in seen] == [None, "2"]


def test_a_given_last_event_id_is_sent_on_the_first_connection_and_replaced_later() -> None:
    def first(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=SSE, stream=Broken([b"id: 9\nevent: x\ndata: 1\n\n"], drop(request)))

    def second(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=SSE, content=b"event: end\ndata: {}\n\n")

    handler, seen = scripted([first, second])
    events = list(published(handler).events("run_1", last_event_id="7", reconnect=FAST))
    assert [event.event for event in events] == ["x", "end"]
    assert [request.headers.get("last-event-id") for request in seen] == ["7", "9"]


def test_a_stream_that_ends_before_its_end_event_is_reconnected_and_one_with_end_is_not() -> None:
    handler, seen = scripted(
        [
            lambda _r: httpx.Response(200, headers=SSE, content=b"event: status\ndata: {}\n\n"),
            lambda _r: httpx.Response(200, headers=SSE, content=b"event: end\ndata: {}\n\nevent: extra\ndata: {}\n\n"),
        ]
    )
    events = [event.event for event in published(handler).events("run_1", reconnect=FAST)]
    # After ``end`` the reconnecting stream stops: nothing behind it is read, no further connection made.
    assert events == ["status", "end"] and len(seen) == 2
    # Without reconnect the early end is the end, as before.
    handler, seen = scripted([lambda _r: httpx.Response(200, headers=SSE, content=b"event: status\ndata: {}\n\n")])
    assert [event.event for event in published(handler).events("run_1")] == ["status"] and len(seen) == 1


def test_without_reconnect_a_dropped_stream_raises_as_before() -> None:
    handler, seen = scripted(
        [lambda request: httpx.Response(200, headers=SSE, stream=Broken([b"data: 1\n\n"], drop(request)))]
    )
    received: list[Any] = []
    with pytest.raises(NodestroConnectionError):
        for event in published(handler).events("run_1"):
            received.append(event.data)
    assert received == [1] and len(seen) == 1


def test_reconnecting_gives_up_after_the_attempts_without_progress() -> None:
    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    handler, seen = scripted([refused])
    with pytest.raises(NodestroConnectionError, match="connection refused"):
        list(published(handler).events("run_1", reconnect=RetryPolicy(attempts=4, backoff=0.001)))
    assert len(seen) == 4
    # A server that answers and drops each connection after its opening event makes no progress either.
    handler, seen = scripted([status_then_drop])
    with pytest.raises(NodestroConnectionError):
        list(published(handler).events("run_1", reconnect=RetryPolicy(attempts=3, backoff=0.001)))
    assert len(seen) == 3


def test_every_connection_that_brings_new_events_starts_the_count_again() -> None:
    def progress(request: httpx.Request) -> httpx.Response:
        body = [b"event: status\ndata: {}\n\n", f"id: {len(seen)}\nevent: step\ndata: {{}}\n\n".encode()]
        return httpx.Response(200, headers=SSE, stream=Broken(body, drop(request)))

    def done(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=SSE, content=b"event: end\ndata: {}\n\n")

    handler, seen = scripted([progress] * 6 + [done])
    events = list(published(handler).events("run_1", reconnect=RetryPolicy(attempts=2, backoff=0.001)))
    assert [event.event for event in events].count("step") == 6 and events[-1].event == "end"
    assert [request.headers.get("last-event-id") for request in seen] == [None, "1", "2", "3", "4", "5", "6"]


def test_a_long_open_connection_counts_as_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_http, "STABLE_CONNECTION", 0.0)
    handler, seen = scripted(
        [status_then_drop] * 5 + [lambda _r: httpx.Response(200, headers=SSE, content=b"event: end\ndata: {}\n\n")]
    )
    events = list(published(handler).events("run_1", reconnect=RetryPolicy(attempts=2, backoff=0.001)))
    assert len(seen) == 6 and events[-1].event == "end"


def test_server_errors_are_reconnected_and_client_errors_are_raised_at_once() -> None:
    handler, seen = scripted(
        [
            lambda _r: httpx.Response(503, text="starting"),
            lambda _r: httpx.Response(502, text="proxy"),
            lambda _r: httpx.Response(200, headers=SSE, content=b"event: end\ndata: {}\n\n"),
        ]
    )
    assert [event.event for event in published(handler).events("run_1", reconnect=FAST)] == ["end"]
    assert len(seen) == 3
    handler, seen = scripted(
        [
            lambda request: httpx.Response(200, headers=SSE, stream=Broken([b"data: 1\n\n"], drop(request))),
            lambda _r: httpx.Response(404, json={"error": {"code": "run.not_found", "message": "No run"}}),
        ]
    )
    with pytest.raises(NodestroAPIError) as missing:
        list(published(handler).events("run_1", reconnect=RetryPolicy(attempts=5, backoff=0.001)))
    assert missing.value.code == "run.not_found" and len(seen) == 2


def test_a_stalled_stream_is_reconnected() -> None:
    def stalled(request: httpx.Request) -> httpx.Response:
        error = httpx.ReadTimeout("stalled", request=request)
        return httpx.Response(200, headers=SSE, stream=Broken([b"event: status\ndata: {}\n\n"], error))

    handler, seen = scripted(
        [stalled, lambda _r: httpx.Response(200, headers=SSE, content=b"event: end\ndata: {}\n\n")]
    )
    events = list(published(handler).events("run_1", timeout=5, reconnect=FAST))
    assert [event.event for event in events] == ["status", "end"] and len(seen) == 2
    handler, _ = scripted([stalled])
    with pytest.raises(NodestroTimeoutError):
        list(published(handler).events("run_1", timeout=5, reconnect=RetryPolicy(attempts=2, backoff=0.001)))


def test_stop_ends_the_stream_during_the_pause_before_a_reconnect() -> None:
    handler, seen = scripted([status_then_drop])
    stop = threading.Event()
    slow = RetryPolicy(attempts=5, backoff=30.0, max_backoff=30.0)
    received: list[str] = []

    def consume() -> None:
        for event in published(handler).events("run_1", reconnect=slow, stop=stop):
            received.append(event.event)

    worker = threading.Thread(target=consume)
    began = time.monotonic()
    worker.start()
    time.sleep(0.2)  # the stream is now in its first pause of about 30 s
    stop.set()
    worker.join(timeout=10)
    assert not worker.is_alive() and time.monotonic() - began < 10
    assert received == ["status"] and len(seen) == 1


def test_stop_ends_the_stream_after_an_event_and_before_a_connection() -> None:
    stop = threading.Event()
    handler, seen = scripted([lambda _r: httpx.Response(200, headers=SSE, content=b"data: 1\n\ndata: 2\n\n")])
    received: list[Any] = []
    for event in published(handler).events("run_1", reconnect=FAST, stop=stop):
        received.append(event.data)
        stop.set()
    assert received == [1]
    assert list(published(handler).events("run_1", reconnect=FAST, stop=stop)) == [] and len(seen) == 1


def test_the_studio_streams_reconnect_with_a_new_snapshot() -> None:
    def first(request: httpx.Request) -> httpx.Response:
        body = [b'event: snapshot\ndata: {"status": "running"}\n\n', b'event: event\ndata: {"seq": 1}\n\n']
        return httpx.Response(200, headers=SSE, stream=Broken(body, drop(request)))

    def second(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers=SSE, content=b'event: snapshot\ndata: {"status": "succeeded"}\n\nevent: end\ndata: {}\n\n'
        )

    for method in ("events", "run_chat_events"):
        handler, seen = scripted([first, second])
        events = list(getattr(studio(handler), method)("run_1", reconnect=FAST))
        assert [event.event for event in events] == ["snapshot", "event", "snapshot", "end"]
        assert [request.headers.get("last-event-id") for request in seen] == [None, None]  # these streams have no ids


def test_reconnect_takes_true_false_or_a_policy() -> None:
    handler, _ = scripted([lambda _r: httpx.Response(200, headers=SSE, content=b"event: end\ndata: {}\n\n")])
    assert [event.event for event in published(handler).events("run_1", reconnect=True)] == ["end"]
    assert DEFAULT_RECONNECT.attempts == 5 and DEFAULT_RECONNECT.max_backoff == 15.0
    with pytest.raises(TypeError, match="reconnect"):
        published(handler).events("run_1", reconnect=3)  # type: ignore[arg-type]


class _Dropping(BaseHTTPRequestHandler):
    """Event streams of a real HTTP server: the first connection breaks inside its chunked body."""

    protocol_version = "HTTP/1.1"
    connections: ClassVar[list[str | None]] = []

    def log_message(self, *_args: Any) -> None:
        pass

    def do_GET(self) -> None:
        type(self).connections.append(self.headers.get("Last-Event-ID"))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        if len(type(self).connections) == 1:
            event = b"id: 5\nevent: node_started\ndata: {}\n\n"
            self.wfile.write(b"%x\r\n%s\r\n" % (len(event), event))
            self.wfile.write(b"40\r\nid: 6\nevent: node_fin")  # a chunk that never completes
            self.wfile.flush()
            self.connection.shutdown(2)
            return
        for event in (b"id: 6\nevent: node_finished\ndata: {}\n\n", b"event: end\ndata: {}\n\n"):
            self.wfile.write(b"%x\r\n%s\r\n" % (len(event), event))
        self.wfile.write(b"0\r\n\r\n")


@contextlib.contextmanager
def serving(handler: type[BaseHTTPRequestHandler]) -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def test_a_real_connection_that_breaks_inside_its_body_is_reconnected() -> None:
    _Dropping.connections = []
    with serving(_Dropping) as url, PublishedWorkflow(url, "slug", api_key="ndk_test") as api:
        events = [(event.event, event.id) for event in api.events("run_1", reconnect=FAST, timeout=10)]
    assert events == [("node_started", "5"), ("node_finished", "6"), ("end", "6")]
    assert _Dropping.connections == [None, "5"]


# ---- streamed downloads -------------------------------------------------------------------------


def test_a_download_is_delivered_in_chunks_as_they_arrive() -> None:
    body = Broken([b"a" * 10, b"b" * 10, b"c" * 10])
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, stream=body)

    client = studio(handler)
    chunks = client.stream_file("run 1", "file/1", chunk_size=10)
    assert next(chunks) == b"a" * 10
    assert body.pulled == 1  # the rest is not read before it is asked for
    assert b"".join(chunks) == b"b" * 10 + b"c" * 10 and body.closed
    assert seen[0].url.raw_path == b"/api/runs/run%201/files/file%2F1"
    with pytest.raises(ValueError, match="chunk_size"):
        next(client.stream_file("run_1", "file_1", chunk_size=0))


def test_leaving_a_download_early_closes_its_connection() -> None:
    body = Broken([b"x"] * 100)
    client = studio(lambda _r: httpx.Response(200, stream=body))
    with contextlib.closing(client.stream_file("run_1", "file_1")) as chunks:
        next(chunks)
    assert body.closed and body.pulled == 1


def test_a_download_is_retried_before_its_body_starts_and_errors_keep_their_code() -> None:
    handler, seen = scripted([lambda _r: httpx.Response(503), lambda _r: httpx.Response(200, content=b"content")])
    assert b"".join(studio(handler).stream_file("run_1", "file_1")) == b"content" and len(seen) == 2
    missing = {"error": {"code": "file.not_found", "message": "No file with this id"}}
    handler, seen = scripted([lambda _r: httpx.Response(404, json=missing)])
    with pytest.raises(NodestroAPIError) as raised:
        list(published(handler).stream_file("run_1", "file_1"))
    assert (raised.value.status, raised.value.code) == (404, "file.not_found") and len(seen) == 1
    assert seen[0].url.path == "/api/published/slug/runs/run_1/files/file_1"


def test_a_download_that_breaks_off_or_stalls_raises_after_the_chunks_that_arrived() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Broken([b"x" * 4, b"y" * 4], drop(request)))

    received: list[bytes] = []
    with pytest.raises(NodestroConnectionError, match="broke off after 8 bytes"):
        for chunk in studio(broken).stream_file("run_1", "file_1"):
            received.append(chunk)
    assert received == [b"x" * 4, b"y" * 4]

    def stalled(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Broken([b"x"], httpx.ReadTimeout("stalled", request=request)))

    with pytest.raises(NodestroTimeoutError, match="stalled after 1 bytes"):
        list(studio(stalled).stream_file("run_1", "file_1"))


class _Short(BaseHTTPRequestHandler):
    """A real server that promises 1000 bytes and sends 400 before it closes the connection."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: Any) -> None:
        pass

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", "1000")
        self.end_headers()
        self.wfile.write(b"z" * 400)
        self.wfile.flush()
        self.connection.shutdown(2)


def test_a_real_download_shorter_than_its_content_length_is_an_error(tmp_path: Path) -> None:
    with serving(_Short) as url, NodestroClient(url, retry=FAST, timeout=10) as client:
        with pytest.raises(NodestroConnectionError, match="broke off after 400 bytes"):
            list(client.stream_file("run_1", "file_1"))
        # A path is only replaced by a complete file: the old one stays, no partial file is left.
        target = tmp_path / "report.pdf"
        target.write_bytes(b"old")
        with pytest.raises(NodestroConnectionError):
            client.save_file("run_1", "file_1", target)
        assert target.read_bytes() == b"old" and sorted(path.name for path in tmp_path.iterdir()) == ["report.pdf"]
        # A file object keeps what arrived.
        buffer = io.BytesIO()
        with pytest.raises(NodestroConnectionError):
            client.save_file("run_1", "file_1", buffer)
        assert buffer.getvalue() == b"z" * 400


def test_save_file_writes_a_complete_download(tmp_path: Path) -> None:
    client = studio(lambda _r: httpx.Response(200, stream=Broken([b"one ", b"two"])))
    assert client.save_file("run_1", "file_1", tmp_path / "out.txt") == 7
    assert (tmp_path / "out.txt").read_bytes() == b"one two"
    api = published(lambda _r: httpx.Response(200, stream=Broken([b"x" * 3])))
    assert api.save_file("run_1", "file_1", str(tmp_path / "out.txt")) == 3
    assert (tmp_path / "out.txt").read_bytes() == b"xxx" and len(list(tmp_path.iterdir())) == 1
