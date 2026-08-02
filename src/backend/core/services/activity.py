"""Per-user, per-module daily activity counters (P10 M2).

Today the console's dashboard has no notion of *who actually uses this*. These
counters are the missing input: they answer "how many people touched messaging
last week", which is the question a customer asks before renewing.

Two rules shape the whole design:

1. **Never a synchronous DB write in middleware.** Every request would pay for
   it, including the ones that are already the slowest.
2. **Never one write per request.** A 5-minute per-(user, module) cache window
   turns "write on every request" into "write at most twelve times an hour per
   module", which is more than enough resolution for a daily counter.
"""

import logging
import random
from datetime import timedelta

from django.core.cache import cache
from django.db.models import F
from django.utils import timezone

from core import models

logger = logging.getLogger(__name__)

#: URL prefix (after ``/api/v1.0/``) → the column it bumps. Prefix matching, so
#: a new endpoint under an existing area is counted without touching this map.
MODULE_PREFIXES = (
    ("im/", "im_count"),
    ("rooms/", "meeting_count"),
    ("recordings/", "meeting_count"),
    ("calendar/", "calendar_count"),
    ("events/", "calendar_count"),
    ("documents/", "docs_count"),
    ("approval", "approval_count"),
    ("personal-ai/", "ai_count"),
    ("room-ai/", "ai_count"),
    ("summar", "ai_count"),
)

COUNTER_FIELDS = frozenset(field for _prefix, field in MODULE_PREFIXES)

#: One write per user per module per this many seconds.
DEDUPE_WINDOW_SECONDS = 300

#: Counters older than this are dropped. There is no celery beat in this
#: project, so the sweep is triggered probabilistically from the write path —
#: the same pattern the rest of the codebase uses for periodic cleanup.
RETENTION_DAYS = 90
CLEANUP_PROBABILITY = 0.001


def module_for_path(path: str):
    """Map a request path to a counter column, or ``None`` if it counts as nothing."""
    marker = "/api/v1.0/"
    index = path.find(marker)
    if index == -1:
        return None
    tail = path[index + len(marker) :]
    for prefix, field in MODULE_PREFIXES:
        if tail.startswith(prefix):
            return field
    return None


def should_record(user_id, module: str, today) -> bool:
    """True at most once per (user, module) per :data:`DEDUPE_WINDOW_SECONDS`.

    ``cache.add`` is the atomic part: only the first caller in the window gets
    True, so concurrent requests do not each queue a write.
    """
    key = f"act:{user_id}:{today}:{module}"
    try:
        return bool(cache.add(key, 1, timeout=DEDUPE_WINDOW_SECONDS))
    except Exception:  # noqa: BLE001 — no cache backend must not break requests
        logger.debug("activity dedupe cache unavailable", exc_info=True)
        return False


def record_activity(user_id, organization_id=None, module: str = "", day=None):
    """Bump one counter. Safe to call from a task; never raises.

    Resolves the organization itself when the caller did not — the middleware
    deliberately does not, because that is a query and the middleware must not
    touch the database. Someone with no membership is simply not counted:
    these are per-organization figures, and a row with no organization would
    have nowhere to be shown.
    """
    if module not in COUNTER_FIELDS:
        return
    day = day or timezone.localdate()
    if organization_id is None:
        organization_id = (
            models.Membership.objects.filter(
                user_id=user_id, status=models.MembershipStatusChoices.ACTIVE
            )
            .order_by("-is_primary")
            .values_list("organization_id", flat=True)
            .first()
        )
        if organization_id is None:
            return
    try:
        row, created = models.UserDailyActivity.objects.get_or_create(
            user_id=user_id,
            date=day,
            defaults={
                "organization_id": organization_id,
                module: 1,
                "last_seen_at": timezone.now(),
            },
        )
        if not created:
            # F() so two concurrent bumps do not read-modify-write over each
            # other — the reason these are six columns and not a JSONB map.
            models.UserDailyActivity.objects.filter(pk=row.pk).update(
                **{module: F(module) + 1}, last_seen_at=timezone.now()
            )
    except Exception:  # noqa: BLE001 — analytics must not break a request
        logger.exception("failed to record activity for user %s", user_id)
        return

    if random.random() < CLEANUP_PROBABILITY:  # noqa: S311 — not cryptographic
        purge_old_activity()


def purge_old_activity():
    """Drop counters past the retention window."""
    cutoff = timezone.localdate() - timedelta(days=RETENTION_DAYS)
    try:
        models.UserDailyActivity.objects.filter(date__lt=cutoff).delete()
    except Exception:  # noqa: BLE001
        logger.exception("activity cleanup failed")
