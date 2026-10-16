"""Enforced gateway-owned admission, single-use claims and renewable leases."""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from rest_framework.exceptions import PermissionDenied, Throttled

from core.models import BilingualSession, User

LIVE = ("issued", "active")
LEASE_SECONDS = 90
HEARTBEAT_SECONDS = 20


def policy():
    """Reject zero/unbounded limits rather than silently disabling enforcement."""
    result = {
        "max_active": settings.ASSISTANT_TRANSLATION_MAX_ACTIVE,
        "max_daily": settings.ASSISTANT_TRANSLATION_MAX_DAILY,
        "max_seconds": settings.ASSISTANT_TRANSLATION_MAX_SECONDS,
        "idle_seconds": settings.ASSISTANT_TRANSLATION_IDLE_SECONDS,
    }
    if not settings.ASSISTANT_TRANSLATION_ENABLED:
        raise PermissionDenied("Translation is disabled.")
    if any(type(value) is not int or value <= 0 for value in result.values()):
        raise PermissionDenied("Translation limits are unavailable.")
    if (
        not 60 <= result["max_seconds"] <= 3600
        or not 30 <= result["idle_seconds"] <= result["max_seconds"]
    ):
        raise PermissionDenied("Translation time limits are unavailable.")
    return result


@transaction.atomic
def reserve(user):
    """Serialize per-account admission across API workers before issuing a ticket."""
    limits = policy()
    if not User.objects.select_for_update().filter(pk=user.pk, is_active=True).exists():
        raise PermissionDenied
    now = timezone.now()
    owned = BilingualSession.objects.filter(user=user)
    owned.filter(status__in=LIVE, lease_until__lte=now).update(
        status="expired", ended_at=now
    )
    if owned.filter(status__in=LIVE).count() >= limits["max_active"]:
        raise Throttled(detail="Translation session limit reached.", wait=30)
    if (
        owned.filter(
            created_at__gte=now.replace(hour=0, minute=0, second=0, microsecond=0)
        ).count()
        >= limits["max_daily"]
    ):
        raise Throttled(detail="Translation daily limit reached.")
    return BilingualSession.objects.create(
        user=user,
        deadline=now + timedelta(seconds=limits["max_seconds"]),
        lease_until=now + timedelta(seconds=30),
    )


@transaction.atomic
def claim(session_id, user_id):
    """Consume a ticket once using the shared database, including concurrent claims."""
    policy()
    row = (
        BilingualSession.objects.select_for_update()
        .select_related("user")
        .get(pk=session_id, user_id=user_id)
    )
    now = timezone.now()
    if (
        row.status != "issued"
        or row.lease_until <= now
        or row.deadline <= now
        or not row.user.is_active
    ):
        raise PermissionDenied
    row.status = "active"
    row.lease_until = min(row.deadline, now + timedelta(seconds=LEASE_SECONDS))
    row.save(update_fields=["status", "lease_until", "updated_at"])
    return row


@transaction.atomic
def update(session_id, operation):
    """Only an authenticated gateway renews; failures must stop its paid providers."""
    row = (
        BilingualSession.objects.select_for_update()
        .select_related("user")
        .get(pk=session_id)
    )
    now = timezone.now()
    if operation == "close":
        if row.status in LIVE:
            row.status, row.ended_at = "closed", now
            row.save(update_fields=["status", "ended_at", "updated_at"])
        return row.status
    valid = (
        settings.ASSISTANT_TRANSLATION_ENABLED
        and row.user.is_active
        and row.status == "active"
        and row.lease_until > now
        and row.deadline > now
    )
    if not valid:
        if row.status in LIVE:
            row.status, row.ended_at = "expired", now
            row.save(update_fields=["status", "ended_at", "updated_at"])
        return "expired"
    row.lease_until = min(row.deadline, now + timedelta(seconds=LEASE_SECONDS))
    row.save(update_fields=["lease_until", "updated_at"])
    return "active"
