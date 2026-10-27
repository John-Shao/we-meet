"""Metric names from the D6 telemetry contract; label allowlist enforced."""

import logging

logger = logging.getLogger("work.metrics")

LABELS_ALLOWLIST = {
    "org_id",
    "task_id",
    "run_id",
    "operation_id",
    "route",
    "method",
    "status_class",
    "http_status",
    "provider",
    "model",
    "queue",
    "device_class",
    "network_class",
    "reason",
    "outcome",
}

METRICS = {
    "work_api_requests_total",
    "work_api_request_duration_seconds",
    "work_status_visible_seconds",
    "work_first_screen_seconds",
    "work_model_ttft_seconds",
    "work_outbox_lag_seconds",
    "work_unknown_operation_age_minutes",
    "work_quota_reconciliation_diff_tokens",
    "work_quota_unsettled_reservations",
    "work_runs_total",
    "work_task_events_total",
    "work_sse_events_total",
    "work_provider_requests_total",
    "work_workflow_start_total",
    "work_outbox_backlog_events",
}


def emit(name: str, value: float, labels: dict | None = None) -> None:
    if name not in METRICS:
        raise ValueError(f"unknown work metric: {name}")
    labels = labels or {}
    unexpected = set(labels) - LABELS_ALLOWLIST
    if unexpected:
        raise ValueError(f"labels not in allowlist: {sorted(unexpected)}")
    logger.info("metric name=%s value=%s labels=%s", name, value, labels)
