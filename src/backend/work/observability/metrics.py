"""D6 telemetry: the contract's metrics as a real Prometheus registry.

Metric names and the label allowlist come from
``docs/plan/assets/work-r0a-ops-2026-10-25/telemetry-contract.json``; the
recording rules and alerts in ``deploy/observability/prometheus-rules.yaml``
read these series, so a name or label drift here silently disables alerts.

Label sets are fixed per metric because Prometheus requires it.  ``task_id``,
``run_id`` and ``operation_id`` are deliberately absent: D6 keeps per-entity
identity in traces and logs, not in metric labels, where it would explode
cardinality.
"""

import os

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
    multiprocess,
)

LABELS_ALLOWLIST = {
    "device_class",
    "event",
    "http_status",
    "kind",
    "method",
    "model",
    "network_class",
    "org_id",
    "outcome",
    "provider",
    "queue",
    "reason",
    "route",
    "stage",
    "state",
    "status_class",
}

REGISTRY = CollectorRegistry()

_LATENCY_BUCKETS = (0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300)
_MINUTE_BUCKETS = (1, 5, 10, 15, 30, 60, 120, 240, 480, 1440)

_SPECS = [
    (Counter, "work_api_requests_total", ("org_id", "route", "method", "status_class")),
    (Histogram, "work_api_request_duration_seconds", ("org_id", "route", "method")),
    (Histogram, "work_status_visible_seconds", ("org_id",)),
    (
        Histogram,
        "work_first_screen_seconds",
        ("org_id", "device_class", "network_class"),
    ),
    (Histogram, "work_model_ttft_seconds", ("org_id", "provider", "model")),
    (Histogram, "work_outbox_lag_seconds", ("org_id",)),
    (Histogram, "work_unknown_operation_age_minutes", ("org_id",)),
    (Histogram, "work_audit_export_duration_seconds", ("org_id",)),
    (Counter, "work_runs_total", ("org_id", "stage", "outcome")),
    (Counter, "work_task_events_total", ("org_id", "event")),
    (Counter, "work_sse_events_total", ("org_id", "kind")),
    (
        Counter,
        "work_provider_requests_total",
        ("org_id", "provider", "model", "http_status", "status_class"),
    ),
    (Counter, "work_workflow_start_total", ("org_id", "outcome")),
    (Counter, "work_usage_settlements_total", ("org_id", "outcome")),
    (Counter, "work_background_job_runs_total", ("org_id", "kind", "outcome")),
    (Counter, "work_background_job_lease_takeovers_total", ("org_id", "kind")),
    (Counter, "work_audit_export_downloads_total", ("org_id", "outcome")),
    (Gauge, "work_quota_reconciliation_diff_tokens", ("org_id",)),
    (Gauge, "work_quota_unsettled_reservations", ("org_id",)),
    (Gauge, "work_outbox_backlog_events", ("org_id",)),
    (Gauge, "work_outbox_dead_letters", ("org_id",)),
    (Gauge, "work_unknown_operations", ("org_id",)),
    (Gauge, "work_unknown_operation_age_minutes_max", ("org_id",)),
    (Gauge, "work_background_job_last_success_seconds", ("org_id", "kind")),
    (Gauge, "work_directory_projection_lag_seconds", ("org_id",)),
    (Gauge, "work_audit_export_backlog", ("org_id",)),
    (Gauge, "work_content_shred_backlog", ("org_id",)),
]


def _build(spec):
    kind, name, labels = spec
    options = {"registry": REGISTRY, "labelnames": labels}
    if kind is Histogram:
        options["buckets"] = (
            _MINUTE_BUCKETS if name.endswith("_minutes") else _LATENCY_BUCKETS
        )
    return kind(name, name, **options)


_COLLECTORS = {name: _build(spec) for spec in _SPECS for name in (spec[1],)}
_LABELS = {spec[1]: spec[2] for spec in _SPECS}

METRICS = set(_COLLECTORS)


def emit(name: str, value: float, labels: dict | None = None) -> None:
    """Record one sample.  Unknown names and labels fail loudly, not silently."""
    collector = _COLLECTORS.get(name)
    if collector is None:
        raise ValueError(f"unknown work metric: {name}")
    labels = labels or {}
    unexpected = set(labels) - LABELS_ALLOWLIST
    if unexpected:
        raise ValueError(f"labels not in allowlist: {sorted(unexpected)}")
    expected = set(_LABELS[name])
    if set(labels) != expected:
        raise ValueError(
            f"{name} needs labels {sorted(expected)}, got {sorted(labels)}"
        )
    child = collector.labels(**{key: str(labels[key]) for key in _LABELS[name]})
    if isinstance(collector, Counter):
        child.inc(value)
    elif isinstance(collector, Gauge):
        child.set(value)
    else:
        child.observe(value)


def render() -> bytes:
    """Serialise the registry for scraping, honouring gunicorn multiprocess."""
    multiproc_dir = os.environ.get("PROMETHEUS_MULTIPROC_DIR")
    if not multiproc_dir:
        return generate_latest(REGISTRY)
    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry, path=multiproc_dir)
    return generate_latest(registry)
