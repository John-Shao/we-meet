"""Cross-tenant outbox relay: claim, deliver, retry/backoff, dead-letter."""

import json
import logging
import uuid

from work.api import content_store
from work.api.context import fetch_all, role_cursor

logger = logging.getLogger(__name__)


def deliver(event: dict) -> None:
    """E3 delivery boundary; real consumers (runtime/SSE) replace this in E4."""
    payload = event.get("payload") or {}
    if isinstance(payload, str):
        payload = json.loads(payload)
    if payload.get("kind") == "content_shred":
        refs = payload.get("content_refs") or []
        if payload.get("content_ref"):
            refs = [*refs, payload["content_ref"]]
        for ref in refs:
            content_store.delete(event["org_id"], ref)


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
    return {
        "relay_id": relay_id,
        "claimed": len(events),
        "delivered": delivered,
        "failed": failed,
    }
