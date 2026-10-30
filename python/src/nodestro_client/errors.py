"""Errors of the Nodestro API, the same for both of its error formats."""

from __future__ import annotations

from typing import Any


class NodestroClientError(Exception):
    """Base class of every error this client raises."""


class NodestroConnectionError(NodestroClientError):
    """The server could not be reached (after the configured retries)."""


class NodestroTimeoutError(NodestroClientError):
    """A request or a wait took longer than allowed."""


class NodestroAPIError(NodestroClientError):
    """The API answered with an error.

    ``code`` and ``params`` are the machine-readable parts (e.g. ``run.agents_invalid``,
    ``auth.missing``); ``message`` is the technical text. The studio API answers
    ``{"detail", "code", "params"}``, published workflow APIs ``{"error": {...}}``; both
    become this exception.
    """

    def __init__(self, status: int, code: str, message: str, params: dict[str, Any] | None = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.params = params or {}

    @classmethod
    def from_response(cls, status: int, body: Any, text: str = "") -> NodestroAPIError:
        """The error of an answer: ``body`` is its decoded JSON (or ``None``), ``text`` its raw text.

        Answers in neither format (a proxy's HTML page, an empty body, unexpected types) become
        code ``http_error`` with the start of the text, so a broken answer never hides the status.
        """
        if isinstance(body, dict):
            nested = body.get("error")
            if isinstance(nested, dict):
                return cls(
                    status,
                    str(nested.get("code") or "error"),
                    str(nested.get("message") or ""),
                    _params(nested.get("params")),
                )
            if "code" in body or "detail" in body:
                detail = body.get("detail")
                if isinstance(detail, list):  # FastAPI's validation errors
                    return cls(status, str(body.get("code") or "validation_error"), str(detail), {"errors": detail})
                return cls(status, str(body.get("code") or "error"), str(detail or ""), _params(body.get("params")))
        return cls(status, "http_error", text.strip()[:500] or f"HTTP {status}")


def _params(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


class NodestroRunFailed(NodestroClientError):
    """A run that was waited for ended as failed or cancelled."""

    def __init__(self, run: dict[str, Any]) -> None:
        status = run.get("status")
        error = run.get("error")
        super().__init__(f"Run {run.get('id') or run.get('run_id')} {status}: {error}")
        self.run = run
