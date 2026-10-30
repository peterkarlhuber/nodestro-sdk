"""A real Nodestro API server for the SDK tests: agents answer from a script, nothing is paid.

Usage: python scripts/test_server.py --data-dir DIR --port 8060

The agents of the test workflows answer by a keyword in their system prompt: ``WRITER`` writes a
text, ``SLOW`` takes two seconds (to cancel it), ``BROKEN`` fails every other time (to
continue a run). The scripted answers are German on purpose: they are test data, and the tests
look for them in results and files. Needs ``nodestro-api`` (the SDK's ``test`` extra); the SDK
itself never imports it.

``GET /sdk-test-server`` identifies this server: the tests refuse to run against a server given in
``NODESTRO_SDK_SERVER`` that does not answer it, because they create workflows, publications and
keys and a real installation would call paid models.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import threading
import time
from typing import Any

from fastapi.routing import APIRoute
from nodestro_api.app import create_app
from nodestro_api.context import AppConfig
from nodestro_runtime.testing import ScriptedClient, text
import uvicorn

REPEAT = 200
#: The answer of ``GET /sdk-test-server``.
MARKER = {"nodestro_sdk_test_server": True}


def slow(_request: dict[str, Any]) -> Any:
    time.sleep(2)
    return text("Langsam fertig")


class Flaky:
    """Fails every other call: a run fails, its continuation succeeds (also when several test
    suites share one server)."""

    def __init__(self) -> None:
        self.calls = 0
        self.lock = threading.Lock()

    def __call__(self, _request: dict[str, Any]) -> Any:
        with self.lock:
            self.calls += 1
            failing = self.calls % 2 == 1
        return text("abgebrochen", stop_reason="max_tokens") if failing else text("Repariert")


def script() -> dict[str, list[Any]]:
    flaky = Flaky()
    return {
        "WRITER": [text("## Angebot\n\nWir liefern 10 Stück bis Freitag.") for _ in range(REPEAT)],
        "SLOW": [slow for _ in range(REPEAT)],
        "BROKEN": [flaky for _ in range(REPEAT)],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, default=8060)
    args = parser.parse_args()
    client = ScriptedClient(script())
    app = create_app(AppConfig(data_dir=Path(args.data_dir)), client_factory=lambda _provider: client, integrations=[])
    # First, so that no catch-all route of the studio answers it; not part of the OpenAPI document.
    marker = APIRoute("/sdk-test-server", lambda: MARKER, methods=["GET"], include_in_schema=False)
    app.router.routes.insert(0, marker)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
