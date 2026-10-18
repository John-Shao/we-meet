"""Enforced gateway-owned admission, single-use claims and renewable leases."""

import re
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from rest_framework.exceptions import PermissionDenied, Throttled, ValidationError

from core.models import BilingualSession, User

LIVE = ("issued", "active")
LEASE_SECONDS = 90
HEARTBEAT_SECONDS = 20
USAGE_LIMITS = {
    "duration_ms": 3_660_000,
    "input_bytes": 120_000_000,
    "output_bytes": 2_000_000_000,
    "translations": 100_000,
    "providers": 2,
}


def validate_usage(usage, operation):
    """Accept bounded cumulative counters, never arbitrary diagnostic content."""
    if (
        not isinstance(usage, dict)
        or set(usage) != {*USAGE_LIMITS, "correlation", "complete"}
        or not isinstance(usage.get("correlation"), str)
        or not re.fullmatch(r"[0-9a-f]{8}", usage["correlation"])
        or type(usage.get("complete")) is not bool
        or usage["complete"] != (operation == "close")
        or any(
            type(usage.get(k)) is not int or not 0 <= usage[k] <= limit
            for k, limit in USAGE_LIMITS.items()
        )
    ):
        raise ValidationError("Invalid translation usage counters.")
    return usage.copy()


def store_usage(row, usage, now):
    """Make retries idempotent and ignore late snapshots without reviving leases."""
    previous = row.usage
    if row.status == "issued":
        raise ValidationError("Translation session has not been claimed.")
    if previous:
        if previous["correlation"] != usage["correlation"]:
            raise ValidationError("Translation usage correlation changed.")
        if previous["complete"]:
            # A cancelled HTTP heartbeat can finish after the final close.
            if all(usage[k] <= previous[k] for k in USAGE_LIMITS):
                return
            raise ValidationError("Translation usage is already complete.")
        if any(usage[k] < previous[k] for k in USAGE_LIMITS):
            if not usage["complete"] and all(
                usage[k] <= previous[k] for k in USAGE_LIMITS
            ):
                return
            raise ValidationError("Translation usage counters regressed.")
    row.usage, row.usage_updated_at = usage, now
    row.save(update_fields=["usage", "usage_updated_at", "updated_at"])


def account_enabled(user):
    """Require both the feature switch and an explicit active-account allowlist."""
    allowed = settings.ASSISTANT_TRANSLATION_ALLOWED_USER_IDS
    return bool(
        settings.ASSISTANT_TRANSLATION_ENABLED
        and user
        and user.is_active
        and isinstance(allowed, (list, tuple))
        and str(user.pk) in allowed
    )


def policy(user):
    """Reject zero/unbounded limits rather than silently disabling enforcement."""
    result = {
        "max_active": settings.ASSISTANT_TRANSLATION_MAX_ACTIVE,
        "max_daily": settings.ASSISTANT_TRANSLATION_MAX_DAILY,
        "max_seconds": settings.ASSISTANT_TRANSLATION_MAX_SECONDS,
        "idle_seconds": settings.ASSISTANT_TRANSLATION_IDLE_SECONDS,
    }
    if not settings.ASSISTANT_TRANSLATION_ENABLED:
        raise PermissionDenied("Translation is disabled.")
    if not account_enabled(user):
        raise PermissionDenied("Translation is not enabled for this account.")
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
    limits = policy(user)
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
    row = (
        BilingualSession.objects.select_for_update()
        .select_related("user")
        .get(pk=session_id, user_id=user_id)
    )
    policy(row.user)
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
def update(session_id, operation, usage=None):
    """Only an authenticated gateway renews; failures must stop its paid providers."""
    row = (
        BilingualSession.objects.select_for_update()
        .select_related("user")
        .get(pk=session_id)
    )
    now = timezone.now()
    if usage is not None:
        store_usage(row, validate_usage(usage, operation), now)
    if operation == "close":
        if row.status in LIVE:
            row.status, row.ended_at = "closed", now
            row.save(update_fields=["status", "ended_at", "updated_at"])
        return row.status
    valid = (
        account_enabled(row.user)
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
