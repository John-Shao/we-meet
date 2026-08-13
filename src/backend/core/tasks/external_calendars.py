import logging
from datetime import timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import external_calendars
from core.tasks._task import task

logger = logging.getLogger(__name__)


@task
def sync_external_calendar(binding_id: str):
    try:
        external_calendars.sync_binding(binding_id)
    except Exception:
        logger.exception("external calendar sync failed binding=%s", binding_id)


@task
def deliver_calendar_outbox(entry_id: str):
    try:
        external_calendars.flush_outbox(entry_id)
    except Exception:
        logger.exception("external calendar outbox failed entry=%s", entry_id)


@task
def poll_external_calendars():
    ids = models.ExternalCalendarBinding.objects.filter(
        account__status=models.ExternalCalendarAccountStatusChoices.ACTIVE
    ).values_list("id", flat=True)
    for binding_id in ids:
        sync_external_calendar.delay(str(binding_id))
    due = models.CalendarSyncOutbox.objects.filter(
        Q(status="pending")
        | Q(status="failed", next_attempt_at__isnull=False, next_attempt_at__lte=timezone.now())
    ).values_list("id", flat=True)
    for entry_id in due:
        deliver_calendar_outbox.delay(str(entry_id))


@task
def renew_external_calendar_webhooks():
    cfg = getattr(settings, "EXTERNAL_CALENDAR_CONFIGURATION", None) or {}
    callback = str(cfg.get("webhook_base_url") or "").rstrip("/")
    if not callback:
        return
    cutoff = timezone.now() + timedelta(hours=12)
    bindings = models.ExternalCalendarBinding.objects.filter(
        account__status=models.ExternalCalendarAccountStatusChoices.ACTIVE
    ).filter(Q(webhook_expires_at__isnull=True) | Q(webhook_expires_at__lte=cutoff))
    for binding in bindings.select_related("account"):
        try:
            external_calendars.provider(binding.account.provider).renew_webhook(
                binding,
                f"{callback}/api/{settings.API_VERSION}/external-calendars/webhooks",
            )
        except Exception:
            logger.exception("webhook renewal failed binding=%s", binding.id)
