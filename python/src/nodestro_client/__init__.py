"""Nodestro Client: the Python SDK of the Nodestro API.

- :class:`NodestroClient`: the studio REST API of an installation (workflows, runs, approvals,
  continued runs, agents, tools, examples, publishing).
- :class:`PublishedWorkflow`: a published workflow API, authenticated with a Nodestro key
  (served by Nodestro or by an exported project).

The client talks HTTP only; it needs neither the runtime nor the API installed. The request
and response types (:mod:`nodestro_client.models`) are generated from the API's OpenAPI document.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

from ._http import Event, RetryPolicy
from .client import NodestroClient
from .errors import (
    NodestroAPIError,
    NodestroClientError,
    NodestroConnectionError,
    NodestroRunFailed,
    NodestroTimeoutError,
)
from .published import PublishedWorkflow

try:
    __version__ = version("nodestro-client")
except PackageNotFoundError:  # pragma: no cover - running from a source checkout
    __version__ = "0.0.0"

#: The version of the Nodestro API whose OpenAPI document the models were generated from.
API_VERSION = "0.2.0"

__all__ = [
    "API_VERSION",
    "Event",
    "NodestroAPIError",
    "NodestroClient",
    "NodestroClientError",
    "NodestroConnectionError",
    "NodestroRunFailed",
    "NodestroTimeoutError",
    "PublishedWorkflow",
    "RetryPolicy",
    "__version__",
]
