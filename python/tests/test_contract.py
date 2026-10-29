"""The committed OpenAPI document is the one the tested Nodestro API serves (skipped without nodestro-api)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest


def test_the_contract_matches_the_running_api(server: str) -> None:
    committed = json.loads((Path(__file__).resolve().parents[2] / "openapi" / "nodestro-api.json").read_text())
    served = httpx.get(f"{server}/api/openapi.json", timeout=10).json()
    assert served["paths"].keys() == committed["paths"].keys()
    assert served["components"]["schemas"] == committed["components"]["schemas"]


def test_the_contract_is_the_installed_apis_own() -> None:
    openapi = pytest.importorskip("nodestro_api.openapi")
    committed = (Path(__file__).resolve().parents[2] / "openapi" / "nodestro-api.json").read_text(encoding="utf-8")
    assert committed == openapi.text(), "copy openapi/nodestro-api.json from the pinned nodestro-api (make contract)"
