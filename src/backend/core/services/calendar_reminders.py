"""Deliver due calendar reminders to their original source conversations.

Events without a source conversation are intentionally absent from this job:
the existing message-list calendar entry is their only reminder surface. The
job never creates a conversation and never falls back to a meeting room group.

``CalendarEvent.reminder_pushed_at`` is the idempotency guard. Transient IM
failures leave it empty for the next run; a permanently invalid source
conversation is marked ``refused`` to stop stale retries.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from core.models import CalendarEvent, EventStatusChoices, EventVisibilityChoices
from core.services import calendar_im_notify
from core.services.jusi_im import (
    JusiImAdminClient,
    JusiImBadResponseError,
    JusiImUnreachableError,
)

logger = logging.getLogger(__name__)

MAX_LEAD_MINUTES = 2880
STARTED_GRACE_MINUTES = 5

OUTCOME_DELIVERED = "delivered"
# Historical value retained for existing rows; this job no longer writes it.
OUTCOME_NO_CONVERSATION = "no_conversation"
OUTCOME_REFUSED = "refused"


def reminder_lead_minutes(reminders) -> int | None:
    """Return the earliest effective reminder from current or legacy data."""
    leads: list[int] = []
    for raw in reminders or []:
        # New writes are strict integers. Keeping int-like historical values
        # readable here avoids silently losing old reminders during rollout.
        try:
            lead = int(raw)
        except (TypeError, ValueError):
            continue
        if 0 <= lead <= MAX_LEAD_MINUTES:
            leads.append(lead)
    return max(leads) if leads else None


def reminder_trigger_at(start_at, reminders):
    """Return the effective trigger instant, or ``None`` without a reminder."""
    lead = reminder_lead_minutes(reminders)
    return start_at - timedelta(minutes=lead) if lead is not None else None


def push_due_reminders(now=None) -> int:
    """Handle due source-conversation reminders and return the handled count."""
    now = now or timezone.now()
    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
        logger.info("calendar reminders skipped: JUSI_IM_CONFIGURATION incomplete")
        return 0

    horizon = now + timedelta(minutes=MAX_LEAD_MINUTES)
    grace_start = now - timedelta(minutes=STARTED_GRACE_MINUTES)
    candidates = (
        CalendarEvent.objects.filter(
            status=EventStatusChoices.CONFIRMED,
            reminder_pushed_at__isnull=True,
            start_at__gte=grace_start,
            start_at__lte=horizon,
        )
        .exclude(source_conversation_id="")
        .select_related("organizer")
    )

    handled = 0
    for event in candidates:
        trigger_at = reminder_trigger_at(event.start_at, event.reminders)
        if trigger_at is None or now < trigger_at:
            continue
        if _push_one(event, cfg, now=now):
            handled += 1
    return handled


def _lead_minutes(event):
    """Backward-compatible wrapper used by older callers and tests."""
    return reminder_lead_minutes(event.reminders)


def _push_one(event, cfg, *, now) -> bool:
    client = JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )

    local_start = timezone.localtime(event.start_at, event.timezone)
    timing = "已经开始" if now >= event.start_at else "即将开始"
    display_title = (
        "私密日程"
        if event.visibility == EventVisibilityChoices.PRIVATE
        else event.title
    )
    body = f"🔔「{display_title}」{timing}（{local_start:%H:%M}）"

    try:
        calendar_im_notify.post_with_organizer_fallback(
            client,
            event.source_conversation_id,
            body,
            organizer=event.organizer,
        )
    except JusiImUnreachableError as exc:
        logger.warning(
            "reminder push failed transiently for event %s; will retry: %s",
            event.id,
            exc,
        )
        return False
    except JusiImBadResponseError as exc:
        logger.warning(
            "reminder source conversation refused event %s; marking handled: %s",
            event.id,
            exc,
        )
        return _mark_handled(event, None, OUTCOME_REFUSED)

    return _mark_handled(event, event.source_conversation_id, OUTCOME_DELIVERED)


def _mark_handled(event, cid, outcome: str) -> bool:
    event.reminder_pushed_at = timezone.now()
    event.reminder_outcome = outcome
    event.save(update_fields=["reminder_pushed_at", "reminder_outcome", "updated_at"])
    if cid:
        logger.info("reminder pushed for event %s (cid=%s)", event.id, cid)
    else:
        logger.info(
            "reminder marked handled without push for event %s (%s)",
            event.id,
            outcome,
        )
    return True
