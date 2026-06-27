"""Calendar event reminders (P2-c).

A periodic job (k8s CronJob → ``manage.py send_due_reminders``) scans events
whose reminder lead time has arrived but that haven't been reminded yet, and
posts a "🔔 即将开始" nudge into the event room's IM group (creating the group
lazily if it was never opened). Idempotent via ``CalendarEvent.reminder_pushed_at``.

Best-effort: one event's transport failure does NOT abort the batch — its
``reminder_pushed_at`` stays NULL so the next run retries it. Mirrors the
nudge-to-IM pattern of ``meeting_summary._push_summary_to_im``.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from core.models import (
    CalendarEvent,
    EventStatusChoices,
    MeetingConversation,
    RoleChoices,
    User,
)

logger = logging.getLogger(__name__)

# Largest reminder lead we scan for — bounds the candidate query.
MAX_LEAD_HOURS = 24


def push_due_reminders(now=None) -> int:
    """Push IM reminders for events whose reminder time has arrived.

    Returns the number of reminders pushed.
    """
    now = now or timezone.now()
    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
        logger.info("calendar reminders skipped: JUSI_IM_CONFIGURATION incomplete")
        return 0

    horizon = now + timedelta(hours=MAX_LEAD_HOURS)
    candidates = (
        CalendarEvent.objects.filter(
            status=EventStatusChoices.CONFIRMED,
            reminder_pushed_at__isnull=True,
            start_at__gt=now,  # only upcoming events get a "starting soon" nudge
            start_at__lte=horizon,
            room__isnull=False,
        )
        .select_related("room")
    )

    pushed = 0
    for event in candidates:
        lead = _lead_minutes(event)
        if lead is None:
            continue
        if now < event.start_at - timedelta(minutes=lead):
            continue  # reminder time not reached yet
        if _push_one(event, cfg):
            pushed += 1
    return pushed


def _lead_minutes(event):
    """Largest reminder lead (minutes) for the event, or None if it has none."""
    leads = []
    for raw in event.reminders or []:
        try:
            leads.append(int(raw))
        except (TypeError, ValueError):
            continue
    return max(leads) if leads else None


def _push_one(event, cfg) -> bool:
    from core.services.jusi_im import (
        JusiImAdminClient,
        JusiImBadResponseError,
        JusiImUnreachableError,
    )

    client = JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )
    cid = _ensure_conversation(event.room, client)
    if cid is None:
        return False

    local_start = timezone.localtime(event.start_at, event.timezone)
    body = f"🔔 「{event.title}」即将开始（{local_start:%H:%M}）"
    try:
        client.post_message(cid=cid, body=body)
    except (JusiImUnreachableError, JusiImBadResponseError) as exc:
        logger.warning("reminder push failed for event %s: %s", event.id, exc)
        return False

    event.reminder_pushed_at = timezone.now()
    event.save(update_fields=["reminder_pushed_at", "updated_at"])
    logger.info("reminder pushed for event %s (cid=%s)", event.id, cid)
    return True


def _ensure_conversation(room, client):
    """Return the room's IM group cid, lazily creating the group if needed.

    Mirrors RoomViewSet.im_ensure_group. Returns None on jusi error / no owner.
    """
    from core.services.jusi_im import (
        JusiImBadResponseError,
        JusiImUnreachableError,
    )

    existing = MeetingConversation.objects.filter(room=room).first()
    if existing:
        return existing.cid

    owner = (
        room.accesses.filter(role=RoleChoices.OWNER).select_related("user").first()
    )
    owner_uid = str(owner.user.sub or owner.user.id) if owner else ""
    if not owner_uid:
        return None
    member_uids = [str(u.sub or u.id) for u in User.objects.filter(resources=room)]
    if owner_uid not in member_uids:
        member_uids.append(owner_uid)

    cid = MeetingConversation.cid_for_room(room.id)
    try:
        client.create_group(
            cid=cid,
            owner_uid=owner_uid,
            members=member_uids,
            meta={"meeting_id": str(room.id), "source": "we-meet"},
        )
    except (JusiImUnreachableError, JusiImBadResponseError) as exc:
        logger.warning("reminder ensure-group failed for room %s: %s", room.id, exc)
        return None
    MeetingConversation.objects.create(room=room, cid=cid)
    return cid
