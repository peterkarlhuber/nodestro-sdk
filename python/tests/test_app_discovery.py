"""Discovery of the app API contract and version negotiation (no server needed; the real server is in test_client)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from nodestro_client import CONTRACT_VERSIONS, NodestroAPIError, PublishedWorkflow, discover, negotiate

ANONYMOUS = {
    "contract": {"name": "nodestro-app", "versions": [1], "current": 1},
    "backend": {"id": "bk_0123", "name": ""},
    "auth": {"methods": ["api_key", "session"]},
    "tls": {"enabled": False},
}
SIGNED_IN = {
    **ANONYMOUS,
    "backend": {"id": "bk_0123", "name": "Office", "version": "0.2.0", "runtime_version": "0.2.0"},
    "tls": {"enabled": True},
    "capabilities": ["runs", "runs.sync", "events.sse", "teleport"],
    "apps": [{"slug": "offer", "name": "Offer", "release": 3, "links": {"info": "/api/published/offer"}}],
}


def answering(status: int, body: Any = None, *, text: str | None = None, seen: list[httpx.Request] | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        assert request.url.path == "/api/app"
        if text is not None:
            return httpx.Response(status, text=text, headers={"content-type": "text/html"})
        return httpx.Response(status, json=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_negotiate_picks_the_highest_common_version() -> None:
    assert CONTRACT_VERSIONS == (1,)
    assert negotiate([1]) == 1
    assert negotiate([1, 2], supported=[1, 2, 3]) == 2
    assert negotiate([2, 3]) is None
    assert negotiate([]) is None
    assert negotiate(["1", True, 1.0]) is None


def test_an_anonymous_discovery_names_the_backend_only() -> None:
    seen: list[httpx.Request] = []
    found = discover("http://nodestro.test", http_client=answering(200, ANONYMOUS, seen=seen))
    assert found.compatible and found.version == 1 and not found.legacy
    assert found.backend_id == "bk_0123" and found.backend_name == ""
    assert found.auth_methods == {"api_key", "session"} and found.tls is False
    assert found.capabilities == frozenset() and found.apps == ()
    assert "authorization" not in seen[0].headers


def test_a_key_adds_capabilities_and_apps() -> None:
    seen: list[httpx.Request] = []
    found = discover("http://nodestro.test", api_key="ndk_x", http_client=answering(200, SIGNED_IN, seen=seen))
    assert seen[0].headers["authorization"] == "Bearer ndk_x"
    assert found.backend_name == "Office" and found.tls is True
    assert found.supports("runs.sync") and not found.supports("approvals")
    assert found.supports("teleport")  # unknown names are kept, never an error
    assert [app["slug"] for app in found.apps] == ["offer"]


def test_no_common_version_is_incompatible_not_an_error() -> None:
    body = {**ANONYMOUS, "contract": {"name": "nodestro-app", "versions": [2, 3], "current": 3}}
    found = discover("http://nodestro.test", http_client=answering(200, body))
    assert not found.compatible and not found.legacy and found.offered == (2, 3)


@pytest.mark.parametrize(
    ("status", "body", "text"),
    [
        (404, {"detail": "Not Found"}, None),
        (405, {"detail": "Method Not Allowed"}, None),
        (200, None, "<html>an old web interface</html>"),
        (200, {"version": "0.1.0"}, None),
        (200, {"contract": {"name": "other"}, "backend": {"id": "x"}}, None),
        (200, {"contract": {"name": "nodestro-app", "versions": [1]}, "backend": {"id": ""}}, None),
    ],
)
def test_a_backend_older_than_the_contract_is_legacy(status: int, body: Any, text: str | None) -> None:
    found = discover("http://nodestro.test", http_client=answering(status, body, text=text))
    assert found.legacy and not found.compatible


def test_a_wrong_key_raises() -> None:
    refused = {"error": {"code": "auth.invalid", "message": "Invalid key"}}
    with pytest.raises(NodestroAPIError) as error:
        discover("http://nodestro.test", api_key="ndk_wrong", http_client=answering(401, refused))
    assert error.value.status == 401 and error.value.code == "auth.invalid"


def test_an_invalid_key_value_is_refused_before_sending() -> None:
    with pytest.raises(ValueError):
        discover("http://nodestro.test", api_key="ndk\r\nX-Evil: 1")


def test_a_published_workflow_discovers_with_its_key() -> None:
    seen: list[httpx.Request] = []
    api = PublishedWorkflow(
        "http://nodestro.test", "offer", api_key="ndk_y", http_client=answering(200, SIGNED_IN, seen=seen)
    )
    assert api.discover().supports("events.sse")
    assert seen[0].headers["authorization"] == "Bearer ndk_y"
