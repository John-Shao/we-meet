"""E7 observability guards: metric allowlist and no-content logging."""

import json
from pathlib import Path

import pytest

from work.observability.log_scan import scan_text
from work.observability.logging import ContentLeakError, assert_no_content
from work.observability.metrics import LABELS_ALLOWLIST, METRICS, emit, render

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
    contract_names = set()
    for entry in document["metrics"]:
        base = entry
        for suffix in ("_bucket", "_sum", "_count"):
            base = base.removesuffix(suffix)
        contract_names.add(base)
    assert METRICS <= contract_names
    emit("work_sse_events_total", 1, {"org_id": "org-1", "kind": "delivered"})
    with pytest.raises(ValueError):
        emit("work_sse_events_total", 1, {"unknown": "x"})
    with pytest.raises(ValueError):
        emit("not_a_metric", 1)


def test_metric_labels_must_match_the_declared_set():
    # A dropped label silently changes the series the alert rules read, so the
    # emit call fails instead of exporting a half-labelled sample.
    with pytest.raises(ValueError):
        emit("work_sse_events_total", 1, {"org_id": "org-1"})


def test_entity_ids_are_not_metric_labels():
    # D6 keeps task/run/operation identity in traces and logs: as metric
    # labels they would blow up cardinality.
    assert {"task_id", "run_id", "operation_id"} & LABELS_ALLOWLIST == set()


def test_registry_renders_the_series_the_alert_rules_read():
    emit(
        "work_api_requests_total",
        1,
        {
            "org_id": "org-1",
            "route": "work-task-collection",
            "method": "POST",
            "status_class": "2xx",
        },
    )
    emit(
        "work_api_request_duration_seconds",
        0.1,
        {"org_id": "org-1", "route": "work-task-collection", "method": "POST"},
    )
    exposition = render().decode("utf-8")
    assert "work_api_requests_total{" in exposition
    assert "work_api_request_duration_seconds_bucket{le=" in exposition


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
