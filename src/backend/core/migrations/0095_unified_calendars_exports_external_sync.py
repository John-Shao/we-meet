import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import timezone_field.fields


def backfill_primary_calendars(apps, schema_editor):
    Calendar = apps.get_model("core", "Calendar")
    CalendarEvent = apps.get_model("core", "CalendarEvent")
    Calendar.objects.all().update(kind="primary")
    for event in CalendarEvent.objects.filter(source_calendar__isnull=True).iterator(
        chunk_size=500
    ):
        calendar, _ = Calendar.objects.get_or_create(
            organization_id=event.organization_id,
            owner_id=event.organizer_id,
            kind="primary",
        )
        CalendarEvent.objects.filter(pk=event.pk).update(source_calendar_id=calendar.pk)


class Migration(migrations.Migration):
    dependencies = [("core", "0094_calendar_all_day_preferences")]

    operations = [
        migrations.RenameModel(old_name="PersonalCalendar", new_name="Calendar"),
        migrations.RenameModel(
            old_name="CalendarAccessGrant", new_name="CalendarMembership"
        ),
        migrations.RemoveConstraint(
            model_name="calendar", name="personal_calendar_unique_org_owner"
        ),
        migrations.AddField(
            model_name="calendar",
            name="kind",
            field=models.CharField(
                choices=[
                    ("primary", "Primary calendar"),
                    ("shared", "Shared calendar"),
                    ("resource", "Resource calendar"),
                    ("external", "External calendar"),
                ],
                default="primary",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="calendar",
            name="name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="calendar",
            name="description",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="calendar",
            name="deleted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="calendar",
            name="share_link_version",
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.AddField(
            model_name="calendar",
            name="meeting_room",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="calendar",
                to="core.meetingroom",
            ),
        ),
        migrations.AlterField(
            model_name="calendar",
            name="owner",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="personal_calendars",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="calendarmembership",
            name="permission",
            field=models.CharField(
                choices=[
                    ("free_busy", "Free/busy only"),
                    ("details", "Event details"),
                    ("writer", "Can edit events"),
                    ("admin", "Calendar administrator"),
                ],
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="calendarevent",
            name="source_calendar",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="source_events",
                to="core.calendar",
            ),
        ),
        migrations.AddField(
            model_name="calendarevent",
            name="location",
            field=models.CharField(blank=True, default="", max_length=512),
        ),
        migrations.AddField(
            model_name="calendarevent",
            name="attachment_names",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="calendarevent",
            name="sync_status",
            field=models.CharField(blank=True, default="", max_length=24),
        ),
        migrations.RunPython(backfill_primary_calendars, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="calendar",
            constraint=models.UniqueConstraint(
                condition=models.Q(("kind", "primary")),
                fields=("organization", "owner"),
                name="calendar_unique_primary_org_owner",
            ),
        ),
        migrations.AddConstraint(
            model_name="calendar",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(("kind", "resource"), meeting_room__isnull=False)
                    | ~models.Q(("kind", "resource"))
                ),
                name="calendar_resource_has_room",
            ),
        ),
        migrations.CreateModel(
            name="CalendarExportJob",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("range_start", models.DateField()),
                ("range_end", models.DateField()),
                (
                    "timezone",
                    timezone_field.fields.TimeZoneField(
                        choices_display="WITH_GMT_OFFSET", default="UTC"
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("queued", "Queued"),
                            ("running", "Running"),
                            ("succeeded", "Succeeded"),
                            ("failed", "Failed"),
                        ],
                        default="queued",
                        max_length=16,
                    ),
                ),
                ("row_count", models.PositiveIntegerField(default=0)),
                ("document_id", models.CharField(blank=True, default="", max_length=255)),
                (
                    "csv_file",
                    models.FileField(
                        blank=True,
                        null=True,
                        upload_to="calendar-exports/%Y/%m/%d/",
                    ),
                ),
                ("csv_token", models.CharField(blank=True, default="", max_length=96)),
                ("csv_expires_at", models.DateTimeField(blank=True, null=True)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_detail", models.TextField(blank=True, default="")),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "calendar",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="export_jobs",
                        to="core.calendar",
                    ),
                ),
                (
                    "requester",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="calendar_export_jobs",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "meet_calendar_export_job", "ordering": ("-created_at",)},
        ),
        migrations.AddIndex(
            model_name="calendarexportjob",
            index=models.Index(
                fields=["requester", "status"], name="calexport_requester_status_idx"
            ),
        ),
        migrations.CreateModel(
            name="ExternalCalendarAccount",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("provider", models.CharField(choices=[("google", "Google Calendar"), ("microsoft", "Microsoft Calendar")], max_length=16)),
                ("provider_account_id", models.CharField(max_length=255)),
                ("email", models.EmailField(blank=True, default="", max_length=254)),
                ("access_token_encrypted", models.TextField(blank=True, default="")),
                ("refresh_token_encrypted", models.TextField(blank=True, default="")),
                ("token_expires_at", models.DateTimeField(blank=True, null=True)),
                ("scopes", models.JSONField(blank=True, default=list)),
                ("status", models.CharField(choices=[("active", "Active"), ("reauth_required", "Reauthorization required"), ("error", "Error")], default="active", max_length=24)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("organization", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="external_calendar_accounts", to="core.organization")),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="external_calendar_accounts", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "meet_external_calendar_account"},
        ),
        migrations.AddConstraint(
            model_name="externalcalendaraccount",
            constraint=models.UniqueConstraint(fields=("owner", "provider", "provider_account_id"), name="extcal_account_unique_owner_provider_id"),
        ),
        migrations.CreateModel(
            name="ExternalCalendarBinding",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("remote_calendar_id", models.CharField(max_length=1024)),
                ("remote_name", models.CharField(blank=True, default="", max_length=255)),
                ("is_primary", models.BooleanField(default=False)),
                ("sync_cursor", models.TextField(blank=True, default="")),
                ("sync_window_start", models.DateField(blank=True, null=True)),
                ("sync_window_end", models.DateField(blank=True, null=True)),
                ("webhook_id", models.CharField(blank=True, default="", max_length=255)),
                ("webhook_secret", models.CharField(blank=True, default="", max_length=255)),
                ("webhook_expires_at", models.DateTimeField(blank=True, null=True)),
                ("last_synced_at", models.DateTimeField(blank=True, null=True)),
                ("sync_status", models.CharField(blank=True, default="pending", max_length=24)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("account", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="bindings", to="core.externalcalendaraccount")),
                ("calendar", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="external_binding", to="core.calendar")),
            ],
            options={"db_table": "meet_external_calendar_binding"},
        ),
        migrations.AddConstraint(
            model_name="externalcalendarbinding",
            constraint=models.UniqueConstraint(fields=("account", "remote_calendar_id"), name="extcal_binding_unique_account_remote"),
        ),
        migrations.CreateModel(
            name="ExternalEventMirror",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("remote_event_id", models.CharField(max_length=1024)),
                ("remote_revision", models.CharField(blank=True, default="", max_length=512)),
                ("remote_updated_at", models.DateTimeField(blank=True, null=True)),
                ("remote_payload", models.JSONField(blank=True, default=dict)),
                ("conflict_payload", models.JSONField(blank=True, default=dict)),
                ("binding", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="event_mirrors", to="core.externalcalendarbinding")),
                ("event", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="external_mirror", to="core.calendarevent")),
            ],
            options={"db_table": "meet_external_event_mirror"},
        ),
        migrations.AddConstraint(
            model_name="externaleventmirror",
            constraint=models.UniqueConstraint(fields=("binding", "remote_event_id"), name="extcal_mirror_unique_binding_event"),
        ),
        migrations.CreateModel(
            name="CalendarSyncOutbox",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("operation", models.CharField(choices=[("create", "Create"), ("update", "Update"), ("delete", "Delete")], max_length=16)),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("expected_revision", models.CharField(blank=True, default="", max_length=512)),
                ("status", models.CharField(choices=[("pending", "Pending"), ("running", "Running"), ("conflict", "Conflict"), ("succeeded", "Succeeded"), ("failed", "Failed")], default="pending", max_length=16)),
                ("attempts", models.PositiveSmallIntegerField(default=0)),
                ("next_attempt_at", models.DateTimeField(blank=True, null=True)),
                ("last_error", models.TextField(blank=True, default="")),
                ("binding", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="outbox_entries", to="core.externalcalendarbinding")),
                ("event", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="sync_outbox_entries", to="core.calendarevent")),
            ],
            options={"db_table": "meet_calendar_sync_outbox", "ordering": ("created_at",)},
        ),
        migrations.AddIndex(
            model_name="calendarsyncoutbox",
            index=models.Index(fields=["status", "next_attempt_at"], name="calsync_status_next_idx"),
        ),
    ]
