import logging
import uuid
from datetime import timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import django.db.models.deletion
from django.db import migrations, models

import timezone_field.fields

logger = logging.getLogger(__name__)


def backfill_all_day_dates(apps, schema_editor):
    CalendarEvent = apps.get_model("core", "CalendarEvent")
    rows = []
    anomalies = 0
    queryset = CalendarEvent.objects.filter(all_day=True).only(
        "id", "start_at", "end_at", "timezone"
    )
    for event in queryset.iterator(chunk_size=1000):
        try:
            zone = ZoneInfo(str(event.timezone))
        except (ZoneInfoNotFoundError, ValueError):
            zone = ZoneInfo("UTC")
            anomalies += 1
        local_start = event.start_at.astimezone(zone)
        local_end = event.end_at.astimezone(zone)
        if local_start.timetz().replace(tzinfo=None).isoformat() != "00:00:00" or (
            local_end.timetz().replace(tzinfo=None).isoformat() != "00:00:00"
        ):
            anomalies += 1
        event.start_date = local_start.date()
        event.end_date = local_end.date()
        if event.end_date <= event.start_date:
            event.end_date = event.start_date + timedelta(days=1)
            anomalies += 1
        rows.append(event)
        if len(rows) == 1000:
            CalendarEvent.objects.bulk_update(
                rows, ["start_date", "end_date"], batch_size=1000
            )
            rows.clear()
    if rows:
        CalendarEvent.objects.bulk_update(
            rows, ["start_date", "end_date"], batch_size=1000
        )
    if anomalies:
        logger.warning(
            "0094 backfilled all-day dates with %d timezone/non-midnight anomalies; "
            "dates were derived deterministically in each event timezone",
            anomalies,
        )


class Migration(migrations.Migration):
    dependencies = [("core", "0093_calendar_sharing_visibility")]

    operations = [
        migrations.AddField(
            model_name="calendarevent",
            name="end_date",
            field=models.DateField(blank=True, null=True, verbose_name="end date"),
        ),
        migrations.AddField(
            model_name="calendarevent",
            name="start_date",
            field=models.DateField(blank=True, null=True, verbose_name="start date"),
        ),
        migrations.RunPython(backfill_all_day_dates, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="calendarevent",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(
                        all_day=True,
                        start_date__isnull=False,
                        end_date__isnull=False,
                        end_date__gt=models.F("start_date"),
                    )
                    | models.Q(
                        all_day=False,
                        start_date__isnull=True,
                        end_date__isnull=True,
                    )
                ),
                name="calevent_all_day_dates_consistent",
            ),
        ),
        migrations.CreateModel(
            name="CalendarPreference",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        editable=False,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        editable=False,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                (
                    "timezone_mode",
                    models.CharField(
                        choices=[
                            ("auto", "Use device timezone"),
                            ("fixed", "Use a fixed timezone"),
                        ],
                        default="auto",
                        max_length=8,
                    ),
                ),
                (
                    "timezone",
                    timezone_field.fields.TimeZoneField(
                        blank=True,
                        choices_display="WITH_GMT_OFFSET",
                        help_text=(
                            "Fixed calendar timezone; empty while timezone_mode is auto."
                        ),
                        null=True,
                        use_pytz=False,
                        verbose_name="calendar timezone",
                    ),
                ),
                (
                    "week_start",
                    models.CharField(
                        choices=[("mon", "Monday"), ("sun", "Sunday")],
                        default="mon",
                        max_length=3,
                    ),
                ),
                (
                    "default_duration_minutes",
                    models.PositiveSmallIntegerField(default=60),
                ),
                (
                    "default_reminder_minutes",
                    models.PositiveSmallIntegerField(blank=True, default=10, null=True),
                ),
                ("dim_past", models.BooleanField(default=True)),
                ("show_weekend", models.BooleanField(default=True)),
                (
                    "working_start_minutes",
                    models.PositiveSmallIntegerField(default=540),
                ),
                (
                    "working_end_minutes",
                    models.PositiveSmallIntegerField(default=1080),
                ),
                (
                    "calendar_time_range",
                    models.CharField(
                        choices=[("work", "Working hours"), ("full", "Full day")],
                        default="work",
                        max_length=8,
                    ),
                ),
                (
                    "meeting_rooms_time_range",
                    models.CharField(
                        choices=[("work", "Working hours"), ("full", "Full day")],
                        default="work",
                        max_length=8,
                    ),
                ),
                (
                    "initialized",
                    models.BooleanField(
                        default=False,
                        help_text=(
                            "Whether an upgraded client has imported its local settings."
                        ),
                    ),
                ),
                ("revision", models.PositiveIntegerField(default=0)),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="calendar_preference",
                        to="core.user",
                    ),
                ),
            ],
            options={"db_table": "meet_calendar_preference"},
        ),
    ]
