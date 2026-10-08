"""Track direct grants and optionally limit issuance, independently of provider billing."""

from contextlib import contextmanager
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from rest_framework.exceptions import PermissionDenied, Throttled

from core import models

LIVE = ("allocating", "issued", "active")
LEASE_SECONDS = 120
MAX_LIFETIME_SECONDS = 43200


def lock_user(user):
    """Account revocation races return a controlled error instead of issuing another grant."""
    try:
        models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
    except models.User.DoesNotExist as error:
        raise PermissionDenied from error


def expire(now=None):
    """Reclaim declarations from crashed/offline clients; does not revoke upstream tokens."""
    now = now or timezone.now()
    return models.DirectAIAllocation.objects.filter(
        status__in=LIVE, lease_until__lte=now
    ).update(status="expired", ended_at=now)


def reserve(user, model, transport):
    """Serialize admission across workers without holding a DB lock during HTTP IO."""
    now = timezone.now()
    with transaction.atomic():
        lock_user(user)
        owned = models.DirectAIAllocation.objects.filter(user=user)
        owned.filter(status__in=LIVE, lease_until__lte=now).update(status="expired", ended_at=now)
        active_limit = settings.DIRECT_AI_MAX_ACTIVE_ALLOCATIONS
        daily_limit = settings.DIRECT_AI_MAX_DAILY_ALLOCATIONS
        if active_limit and owned.filter(status__in=LIVE, lease_until__gt=now).count() >= active_limit:
            raise Throttled(detail="Direct AI session admission limit reached.", wait=LEASE_SECONDS)
        if daily_limit and owned.filter(created_at__gte=now.replace(hour=0, minute=0, second=0, microsecond=0)).count() >= daily_limit:
            raise Throttled(detail="Direct AI daily allocation limit reached.")
        return models.DirectAIAllocation.objects.create(
            user=user, model=model, transport=transport,
            lease_until=now + timedelta(seconds=LEASE_SECONDS),
        )


class Allocation:
    def __init__(self, row):
        self.row = row
        self.issued = False

    def issue(self):
        """Return opaque application metadata, unrelated to the provider connection token."""
        self.issued = True
        now = timezone.now()
        models.DirectAIAllocation.objects.filter(pk=self.row.pk, status="allocating").update(
            status="issued", lease_until=now + timedelta(seconds=LEASE_SECONDS)
        )
        return {"id": str(self.row.pk), "ttl_seconds": LEASE_SECONDS, "heartbeat_seconds": 30,
                "enforce": bool(settings.DIRECT_AI_MAX_ACTIVE_ALLOCATIONS)}


@contextmanager
def allocating(user, model, transport):
    allocation = Allocation(reserve(user, model, transport))
    try:
        yield allocation
    finally:
        if not allocation.issued:
            models.DirectAIAllocation.objects.filter(pk=allocation.row.pk, status__in=LIVE).update(
                status="failed", ended_at=timezone.now()
            )


@transaction.atomic
def update(user, allocation_id, operation):
    """An expired/closed lease is never revived by a delayed heartbeat."""
    lock_user(user)
    row = models.DirectAIAllocation.objects.select_for_update().get(pk=allocation_id, user=user)
    now = timezone.now()
    if operation == "close":
        if row.status in LIVE:
            row.status, row.ended_at = "closed", now
            row.save(update_fields=["status", "ended_at", "updated_at"])
        return row.status
    deadline = row.created_at + timedelta(seconds=MAX_LIFETIME_SECONDS)
    if row.status not in LIVE or row.lease_until <= now or deadline <= now:
        if row.status in LIVE:
            row.status, row.ended_at = "expired", now
            row.save(update_fields=["status", "ended_at", "updated_at"])
        return "expired"
    row.status, row.last_seen_at = "active", now
    row.lease_until = min(now + timedelta(seconds=LEASE_SECONDS), deadline)
    row.save(update_fields=["status", "last_seen_at", "lease_until", "updated_at"])
    return row.status
