"""Close expired/cancelled reservations without deleting materials or live meetings."""

import logging
from datetime import datetime, time, timedelta
from functools import partial

from django.conf import settings
from django.db import transaction
from django.db.models.signals import post_delete, post_save, pre_save
from django.utils import timezone

from dateutil.rrule import rrulestr

from core import models
from core.services.calendar_time import parse_zone

logger = logging.getLogger(__name__)


def schedule_is_valid(event, now):
    """Use civil dates for all-day events and check unmaterialized recurrences too."""
    if event.status != models.EventStatusChoices.CONFIRMED:
        return False
    grace = timedelta(seconds=settings.ROOM_RESERVATION_GRACE_SECONDS)
    zone = parse_zone(event.timezone)
    end = event.end_at
    start = event.start_at
    if event.all_day and event.end_date and event.start_date:
        start = timezone.make_aware(datetime.combine(event.start_date, time.min), zone)
        end = timezone.make_aware(datetime.combine(event.end_date, time.min), zone)
    if end + grace > now:
        return True
    if not event.recurrence:
        return False
    try:
        # Match calendar_recurrence's local wall-clock expansion, including DST.
        local_start = start.astimezone(zone).replace(tzinfo=None)
        duration = end.astimezone(zone).replace(tzinfo=None) - local_start
        cutoff = (now - grace).astimezone(zone).replace(tzinfo=None) - duration
        rule = rrulestr(event.recurrence, dtstart=local_start)
        excluded = {datetime.fromisoformat(value) for value in event.recurrence_exdates}
        for occurrence in rule.xafter(cutoff, count=len(excluded) + 1):
            if timezone.make_aware(occurrence, zone) not in excluded:
                return True
        return False
    except (ValueError, TypeError, OverflowError):
        # An invalid legacy rule must not silently cancel someone's series.
        logger.warning("room.reservation_invalid_recurrence event_id=%s", event.pk)
        return True


def closing_reason(room, now):
    """Return a reason only when no active session or valid appointment needs the room."""
    if room.ended_at or room.meeting_sessions.filter(status="active").exists():
        return ""
    events = list(room.calendar_events.all())
    if any(schedule_is_valid(event, now) for event in events):
        return ""
    if room.reservation_cancelled_at or (
        events and all(event.status == "cancelled" for event in events)
    ):
        return "reservation_cancelled"
    if events:
        return "reservation_expired"
    if (
        room.scheduled_at
        and room.scheduled_at
        + timedelta(seconds=settings.ROOM_RESERVATION_GRACE_SECONDS)
        <= now
    ):
        return "reservation_expired"
    return ""


def reconcile_room(room_id, *, cancelled=False, now=None):
    """Recheck under the room lock; meeting session creation takes the same lock."""
    now = now or timezone.now()
    with transaction.atomic():
        room = models.Room.objects.select_for_update().filter(pk=room_id).first()
        if room is None or room.ended_at:
            return room
        if cancelled and not any(
            schedule_is_valid(event, now) for event in room.calendar_events.all()
        ):
            room.reservation_cancelled_at = now
            room.save(update_fields=["reservation_cancelled_at"])
        reason = closing_reason(room, now)
        if reason:
            room.ended_at = now
            room.closure_reason = reason
            room.save(update_fields=["ended_at", "closure_reason", "updated_at"])
            logger.info("room.reservation_closed room_id=%s reason=%s", room.pk, reason)
        return room


def reconcile_for_entry(room):
    """Lazy enforcement keeps old links closed even if Celery beat is delayed."""
    if not room.ended_at and (room.scheduled_at or room.reservation_cancelled_at):
        current = reconcile_room(room.pk)
        if current:
            room.ended_at = current.ended_at
            room.closure_reason = current.closure_reason
    return room


def _before_event_save(sender, instance, raw=False, **kwargs):
    if raw or not instance.pk:
        return
    previous = sender.objects.filter(pk=instance.pk).values("room_id", "status").first()
    instance._reservation_previous = previous  # noqa: SLF001


def _event_saved(sender, instance, raw=False, **kwargs):
    if raw:
        return
    previous = getattr(instance, "_reservation_previous", None)
    if (
        previous
        and previous["room_id"]
        and (previous["room_id"] != instance.room_id or instance.status == "cancelled")
    ):
        transaction.on_commit(
            partial(reconcile_room, previous["room_id"], cancelled=True)
        )


def _event_deleted(sender, instance, **kwargs):
    if instance.room_id:
        # Resolve after the whole series edit commits, not between delete/recreate.
        transaction.on_commit(partial(reconcile_room, instance.room_id, cancelled=True))


def _session_saved(sender, instance, raw=False, **kwargs):
    if not raw and instance.status == "ended":
        transaction.on_commit(partial(reconcile_room, instance.room_id))


def connect_handlers():
    for signal, handler in (
        (pre_save, _before_event_save),
        (post_save, _event_saved),
        (post_delete, _event_deleted),
    ):
        signal.connect(
            handler,
            sender=models.CalendarEvent,
            dispatch_uid=f"room_reservations_{handler.__name__}",
        )
    post_save.connect(
        _session_saved,
        sender=models.MeetingSession,
        dispatch_uid="room_reservations_session_ended",
    )
