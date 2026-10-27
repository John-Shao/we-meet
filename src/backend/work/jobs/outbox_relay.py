"""Cross-tenant outbox relay: claim, deliver, retry/backoff, dead-letter.

E4: dispatches ``start_workflow`` and ``cancel_signal`` outbox events to
Temporal via :mod:`work.orchestration.temporal_client`.  Other event kinds
(``content_shred``) are handled locally as in E3.
"""

import asyncio
import json
import logging
import time
import uuid

from temporalio.exceptions import ApplicationError
from temporalio.service import RPCError

from work.api import content_store
from work.api.context import fetch_all, role_cursor
from work.observability.metrics import emit
from work.orchestration.temporal_client import get_temporal_client

logger = logging.getLogger(__name__)

TERMINAL_RUN_STATES = frozenset({"succeeded", "failed", "canceled"})


def _run_dispatch_facts(org_id: str, run_id: str) -> dict:
    with role_cursor(org_id, "work_worker") as cursor:
        cursor.execute(
            "SELECT task_id, workflow_id, state FROM work.run "
            "WHERE id = %s AND org_id = %s",
            [run_id, org_id],
        )
        row = cursor.fetchone()
    if row is None:
        raise RuntimeError(f"run not found: {run_id}")
    return {"task_id": str(row[0]), "workflow_id": row[1], "state": row[2]}


def _deliver_start_workflow(event: dict, payload: dict) -> None:
    run_id = payload["run_id"]
    workflow_id = payload["workflow_id"]
    org_id = event["org_id"]
    task_id = _run_dispatch_facts(org_id, run_id)["task_id"]

    tc = get_temporal_client()
    try:
        asyncio.run(
            tc.start_workflow(
                workflow_id=workflow_id,
                run_id=run_id,
                task_id=task_id,
                org_id=org_id,
            )
        )
    except (RPCError, ApplicationError) as exc:
        if "Workflow execution already started" in str(exc):
            logger.info(
                "workflow %s already started (idempotent), event_id=%s",
                workflow_id,
                event["event_id"],
            )
            emit(
                "work_workflow_start_total",
                1,
                {"org_id": org_id, "outcome": "duplicate"},
            )
            return
        emit("work_workflow_start_total", 1, {"org_id": org_id, "outcome": "failed"})
        raise
    emit("work_workflow_start_total", 1, {"org_id": org_id, "outcome": "started"})
    logger.info(
        "started workflow %s for run %s, event_id=%s",
        workflow_id,
        run_id,
        event["event_id"],
    )


def _deliver_cancel_signal(event: dict, payload: dict) -> None:
    """Signal the workflow that owns this Run.

    The workflow id is the one stored on ``work.run`` at submit time; it is not
    derivable from the run id.  A missing workflow only counts as delivered
    once the Run itself is terminal, otherwise the cancel would be lost.
    """
    run_id = payload["run_id"]
    org_id = event["org_id"]
    facts = _run_dispatch_facts(org_id, run_id)
    workflow_id = facts["workflow_id"]
    reason = payload.get("reason") or "user_requested"

    tc = get_temporal_client()
    try:
        asyncio.run(tc.signal_workflow(workflow_id, "cancel", reason))
    except (RPCError, ApplicationError) as exc:
        if "not found" not in str(exc).lower():
            raise
        if facts["state"] not in TERMINAL_RUN_STATES:
            raise
        logger.info(
            "workflow %s gone and run already %s, event_id=%s",
            workflow_id,
            facts["state"],
            event["event_id"],
        )
        return
    logger.info(
        "signaled cancel to workflow %s, event_id=%s",
        workflow_id,
        event["event_id"],
    )


def deliver(event: dict) -> None:
    """Dispatch outbox event to the correct consumer.

    ``start_workflow`` / ``cancel_signal`` → Temporal (E4).
    ``content_shred`` → local content store (E3).
    """
    payload = event.get("payload") or {}
    if isinstance(payload, str):
        payload = json.loads(payload)

    kind = payload.get("kind")
    if kind == "start_workflow":
        _deliver_start_workflow(event, payload)
    elif kind == "cancel_signal":
        _deliver_cancel_signal(event, payload)
    elif kind == "content_shred":
        refs = payload.get("content_refs") or []
        if payload.get("content_ref"):
            refs = [*refs, payload["content_ref"]]
        for ref in refs:
            content_store.delete(event["org_id"], ref)
    else:
        logger.warning(
            "unknown outbox event kind=%s event_id=%s", kind, event["event_id"]
        )


def run_once(relay_id: str | None = None, *, deliver_fn=deliver, limit=20) -> dict:
    relay_id = relay_id or f"relay-{uuid.uuid4().hex[:8]}"
    with role_cursor("", "work_worker") as cursor:
        cursor.execute("SELECT * FROM work.claim_outbox(%s, %s, 60)", [relay_id, limit])
        events = fetch_all(cursor)
    delivered = 0
    failed = 0
    for event in events:
        try:
            deliver_fn(event)
        except Exception:
            logger.exception(
                "work outbox delivery failed event_id=%s aggregate=%s/%s",
                event["id"],
                event["aggregate_type"],
                event["aggregate_id"],
            )
            with role_cursor(event["org_id"], "work_worker") as cursor:
                cursor.execute(
                    "SELECT work.mark_outbox_failed(%s, %s, %s, true)",
                    [event["event_id"], relay_id, "delivery_failed"],
                )
            failed += 1
            continue
        with role_cursor(event["org_id"], "work_worker") as cursor:
            cursor.execute(
                "SELECT work.mark_outbox_delivered(%s, %s)",
                [event["event_id"], relay_id],
            )
        delivered += 1
    for org_id in {event["org_id"] for event in events}:
        emit(
            "work_background_job_runs_total",
            1,
            {"org_id": org_id, "kind": "outbox_relay", "outcome": "succeeded"},
        )
        emit(
            "work_background_job_last_success_seconds",
            time.time(),
            {"org_id": org_id, "kind": "outbox_relay"},
        )
    return {
        "relay_id": relay_id,
        "claimed": len(events),
        "delivered": delivered,
        "failed": failed,
    }
