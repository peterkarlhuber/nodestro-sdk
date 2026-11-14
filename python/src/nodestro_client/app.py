"""Discovery of the Nodestro app API contract (``nodestro-app``, ``GET /api/app``).

Any backend that serves the contract (the desktop studio, its network listener, an exported project, a portable
package) answers ``GET /api/app`` with its contract versions, its id and, for a valid credential, its capabilities and
apps. :func:`discover` reads that answer and picks the contract version to use: the highest one both sides support.
A backend older than the contract has no discovery; the answer then says so (``legacy``) instead of failing, so a
client can fall back to the published workflow API as it is.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, cast

import httpx

from . import models
from ._http import RetryPolicy, Transport
from .errors import NodestroAPIError

#: The contract name and the versions this SDK supports, oldest first.
CONTRACT = "nodestro-app"
CONTRACT_VERSIONS: tuple[int, ...] = (1,)
PATH = "/api/app"


def _whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def negotiate(offered: Iterable[Any], supported: Iterable[int] = CONTRACT_VERSIONS) -> int | None:
    """The highest contract version in both ``offered`` (the backend's ``contract.versions``) and ``supported``;
    ``None`` when there is none. Entries that are not whole numbers are ignored."""
    common = {v for v in offered if _whole(v)} & set(supported)
    return max(common) if common else None


@dataclass(frozen=True)
class Discovery:
    """The answer of :func:`discover`.

    ``version`` is the contract version to use (``None``: no common version, or ``legacy``). ``legacy`` means the
    backend predates the contract (no discovery route); its published workflow API may still work. Capabilities and
    apps are only filled for a valid credential; unknown capability names are kept and simply not used.
    """

    version: int | None
    legacy: bool = False
    offered: tuple[int, ...] = ()
    backend_id: str = ""
    backend_name: str = ""
    auth_methods: frozenset[str] = frozenset()
    tls: bool = False
    capabilities: frozenset[str] = frozenset()
    apps: tuple[models.AppSummary, ...] = ()
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def compatible(self) -> bool:
        """Whether this SDK and the backend share a contract version."""
        return self.version is not None

    def supports(self, capability: str) -> bool:
        """Whether the backend serves ``capability`` (e.g. ``runs.sync``, ``events.sse``)."""
        return capability in self.capabilities


def _legacy() -> Discovery:
    return Discovery(version=None, legacy=True)


def read_discovery(body: Any, supported: Iterable[int] = CONTRACT_VERSIONS) -> Discovery:
    """A :class:`Discovery` from the decoded JSON of ``GET /api/app``; an answer that is not a discovery of this
    contract counts as ``legacy``."""
    if not isinstance(body, dict):
        return _legacy()
    contract, backend = body.get("contract"), body.get("backend")
    if not isinstance(contract, dict) or contract.get("name") != CONTRACT or not isinstance(backend, dict):
        return _legacy()
    if not isinstance(backend.get("id"), str) or not backend["id"]:
        return _legacy()
    versions = contract.get("versions")
    offered = tuple(v for v in versions if _whole(v)) if isinstance(versions, list) else ()
    auth = body.get("auth")
    methods = auth.get("methods") if isinstance(auth, dict) else None
    tls = body.get("tls")
    capabilities = body.get("capabilities")
    apps = body.get("apps")
    name = backend.get("name")
    return Discovery(
        version=negotiate(offered, supported),
        offered=offered,
        backend_id=backend["id"],
        backend_name=name if isinstance(name, str) else "",
        auth_methods=frozenset(m for m in methods if isinstance(m, str)) if isinstance(methods, list) else frozenset(),
        tls=isinstance(tls, dict) and tls.get("enabled") is True,
        capabilities=(
            frozenset(c for c in capabilities if isinstance(c, str)) if isinstance(capabilities, list) else frozenset()
        ),
        apps=tuple(cast(models.AppSummary, a) for a in apps if isinstance(a, dict)) if isinstance(apps, list) else (),
        raw=cast(dict[str, Any], body),
    )


def discover_with(transport: Transport) -> Discovery:
    """:func:`discover` over an existing transport (with its credential headers)."""
    try:
        response = transport.request("GET", PATH)
    except NodestroAPIError as exc:
        # 404 (and 405 from a backend that routes /api/app elsewhere): a backend older than the contract.
        if exc.status in (404, 405):
            return _legacy()
        raise
    try:
        body = response.json()
    except ValueError:
        return _legacy()
    return read_discovery(body)


def discover(
    base_url: str,
    *,
    api_key: str | None = None,
    timeout: float = 30.0,
    retry: RetryPolicy | None = None,
    http_client: httpx.Client | None = None,
) -> Discovery:
    """Ask the backend at ``base_url`` which contract versions, capabilities and apps it serves.

    >>> found = discover("https://office.example", api_key="ndk_...")
    >>> if not found.compatible: ...  # show "incompatible version"; with found.legacy, fall back

    Without ``api_key`` the answer only has the contract, the backend id and name, the sign-in methods and TLS.
    A wrong key raises :class:`~nodestro_client.NodestroAPIError` (401); it is never treated as no key.
    """
    headers: dict[str, str] = {}
    if api_key is not None:
        if not isinstance(api_key, str) or not api_key.strip() or any(c in api_key for c in "\r\n"):
            raise ValueError("api_key must be the non-empty token of a Nodestro API key")
        headers["Authorization"] = f"Bearer {api_key}"
    transport = Transport(base_url, headers=headers, timeout=timeout, retry=retry, client=http_client)
    try:
        return discover_with(transport)
    finally:
        transport.close()
