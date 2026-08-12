"""Calendar civil-date and timezone helpers.

Timed events are instants.  All-day events are civil date ranges whose UTC
timestamps are compatibility/reminder anchors only.  Keeping these conversions
in one module prevents serializers, recurrence materialization, and migrations
from quietly choosing different date semantics.
"""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.utils import timezone

from core import models


def parse_zone(value) -> ZoneInfo:
    """Return one valid IANA zone or raise ``ZoneInfoNotFoundError``."""
    if isinstance(value, ZoneInfo):
        return value
    return ZoneInfo(str(value))


def effective_calendar_timezone(user) -> ZoneInfo:
    """Resolve the server-side fallback used only by legacy calendar writes."""
    preference = models.CalendarPreference.objects.filter(user=user).first()
    if (
        preference is not None
        and preference.timezone_mode == models.CalendarTimezoneModeChoices.FIXED
        and preference.timezone
    ):
        return parse_zone(preference.timezone)
    try:
        return parse_zone(user.timezone)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def all_day_anchors(
    start_date: date,
    end_date: date,
    event_timezone,
) -> tuple[datetime, datetime]:
    """Build exclusive local-midnight anchors for one all-day date range."""
    zone = parse_zone(event_timezone)
    return (
        timezone.make_aware(datetime.combine(start_date, time.min), zone),
        timezone.make_aware(datetime.combine(end_date, time.min), zone),
    )


def dates_from_legacy_anchors(
    start_at: datetime,
    end_at: datetime,
    event_timezone,
) -> tuple[date, date]:
    """Deterministically recover historical dates in the stored event zone."""
    zone = parse_zone(event_timezone)
    return start_at.astimezone(zone).date(), end_at.astimezone(zone).date()
