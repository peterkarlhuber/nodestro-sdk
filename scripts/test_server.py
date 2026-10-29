"""A real Nodestro API server for the SDK tests: agents answer from a script, nothing is paid.

Usage: python scripts/test_server.py --data-dir DIR --port 8060

The agents of the test workflows answer by a keyword in their system prompt: ``WRITER`` writes a
text, ``SLOW`` takes two seconds (to cancel it), ``BROKEN`` fails once and then succeeds (to
continue a run). Needs ``nodestro-api`` (the SDK's ``test`` extra); the SDK itself never imports it.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import threading
import time
from typing import Any

from nodestro_api.app import create_app
from nodestro_api.context import AppConfig
from nodestro_runtime.testing import ScriptedClient, text
import uvicorn

REPEAT = 200


def slow(_request: dict[str, Any]) -> Any:
    time.sleep(2)
    return text("Langsam fertig")


class Flaky:
    """Fails the first time, succeeds afterwards."""

    def __init__(self) -> None:
        self.calls = 0
        self.lock = threading.Lock()

    def __call__(self, _request: dict[str, Any]) -> Any:
        with self.lock:
            self.calls += 1
            first = self.calls == 1
        return text("abgebrochen", stop_reason="max_tokens") if first else text("Repariert")


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
    app = create_app(
        AppConfig(data_dir=Path(args.data_dir)), client_factory=lambda _provider: client, integrations=[]
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
