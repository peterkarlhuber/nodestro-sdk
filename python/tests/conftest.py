"""A real Nodestro API server for the tests (scripts/test_server.py), or the one in NODESTRO_SDK_SERVER."""

from __future__ import annotations

from collections.abc import Iterator
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="session")
def server() -> Iterator[str]:
    given = os.environ.get("NODESTRO_SDK_SERVER")
    if given:
        yield given.rstrip("/")
        return
    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="nodestro-sdk-") as data:
        log = Path(data) / "server.log"
        with log.open("w") as output:
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "test_server.py"),
                    "--data-dir",
                    f"{data}/data",
                    "--port",
                    str(port),
                ],
                stdout=output,
                stderr=subprocess.STDOUT,
            )
            url = f"http://127.0.0.1:{port}"
            try:
                for _ in range(120):
                    try:
                        if httpx.get(f"{url}/api/meta", timeout=1).status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    if process.poll() is not None:
                        raise RuntimeError(log.read_text())
                    time.sleep(0.25)
                else:
                    raise RuntimeError(f"The test server did not start:\n{log.read_text()}")
                yield url
            finally:
                process.terminate()
                process.wait(timeout=10)
