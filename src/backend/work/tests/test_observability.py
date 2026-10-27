"""E7 observability guards: metric allowlist and no-content logging."""

import json
from pathlib import Path

import pytest

from work.observability.log_scan import scan_text
from work.observability.logging import ContentLeakError, assert_no_content
from work.observability.metrics import METRICS, emit

REPO = Path(__file__).resolve().parents[4]
CONTRACT = (
    REPO
    / "docs"
    / "plan"
    / "assets"
    / "work-r0a-ops-2026-10-25"
    / "telemetry-contract.json"
)


def test_metric_names_are_a_subset_of_the_contract():
    document = json.loads(CONTRACT.read_text(encoding="utf-8"))
    contract_names = {name.removesuffix("_bucket") for name in document["metrics"]}
    assert METRICS <= contract_names
    emit("work_sse_events_total", 1, {"org_id": "org-1", "outcome": "ok"})
    with pytest.raises(ValueError):
        emit("work_sse_events_total", 1, {"unknown": "x"})
    with pytest.raises(ValueError):
        emit("not_a_metric", 1)


def test_log_fields_reject_content():
    assert_no_content({"org_id": "org-1", "run_id": "run-1", "reason": "quota"})
    for key in ("goal", "background", "content", "title", "api_key", "prompt"):
        with pytest.raises(ContentLeakError):
            assert_no_content({key: "secret text"})


def test_log_scan_finds_content_and_credentials():
    assert scan_text('{"org_id":"org-1","run_id":"run-1"}') == []
    assert scan_text('{"goal":"private text"}')
    assert scan_text("provider key sk-abcdef123456")
    assert scan_text("-----BEGIN PRIVATE KEY-----")
