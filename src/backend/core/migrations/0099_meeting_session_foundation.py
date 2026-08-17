import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0098_remove_external_calendar_sync"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="MeetingSession",
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
                    "livekit_room_sid",
                    models.CharField(
                        blank=True,
                        help_text="Server-assigned LiveKit room instance identifier.",
                        max_length=64,
                        null=True,
                        unique=True,
                        verbose_name="LiveKit room SID",
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("ended", "Ended")],
                        default="active",
                        max_length=16,
                        verbose_name="status",
                    ),
                ),
                (
                    "started_at",
                    models.DateTimeField(db_index=True, verbose_name="started at"),
                ),
                (
                    "ended_at",
                    models.DateTimeField(
                        blank=True,
                        db_index=True,
                        null=True,
                        verbose_name="ended at",
                    ),
                ),
                (
                    "start_source",
                    models.CharField(
                        choices=[
                            ("livekit_room", "LiveKit room creation time"),
                            ("webhook", "Webhook event time"),
                            ("transcript", "Transcript fallback"),
                            ("legacy", "Legacy backfill"),
                        ],
                        default="webhook",
                        max_length=24,
                        verbose_name="start source",
                    ),
                ),
                (
                    "end_reason",
                    models.CharField(
                        blank=True,
                        choices=[
                            ("room_finished", "LiveKit room finished"),
                            ("owner_ended", "Owner ended room"),
                            ("superseded", "Superseded by a new LiveKit room"),
                            ("reconciled", "Closed by reconciliation"),
                            ("legacy", "Legacy backfill"),
                        ],
                        default="",
                        max_length=24,
                        verbose_name="end reason",
                    ),
                ),
                (
                    "last_event_at",
                    models.DateTimeField(
                        blank=True, null=True, verbose_name="last event at"
                    ),
                ),
                (
                    "room",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="meeting_sessions",
                        to="core.room",
                        verbose_name="room",
                    ),
                ),
            ],
            options={
                "verbose_name": "meeting session",
                "verbose_name_plural": "meeting sessions",
                "db_table": "meet_meeting_session",
                "ordering": ("-started_at",),
                "indexes": [
                    models.Index(
                        fields=["room", "-started_at"],
                        name="meet_sess_room_start_idx",
                    ),
                    models.Index(
                        fields=["status", "updated_at"],
                        name="meet_sess_status_upd_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(("status", "active")),
                        fields=("room",),
                        name="uniq_active_session_per_room",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(
                                ("end_reason", ""),
                                ("ended_at__isnull", True),
                                ("status", "active"),
                            ),
                            models.Q(
                                ("ended_at__isnull", False),
                                ("status", "ended"),
                                models.Q(("end_reason", ""), _negated=True),
                            ),
                            _connector="OR",
                        ),
                        name="session_status_end_consistent",
                    ),
                    models.CheckConstraint(
                        condition=(
                            models.Q(("ended_at__isnull", True))
                            | models.Q(("ended_at__gte", models.F("started_at")))
                        ),
                        name="session_end_not_before_start",
                    ),
                    models.CheckConstraint(
                        condition=(
                            models.Q(
                                ("livekit_room_sid__isnull", True),
                                ("start_source", "legacy"),
                            )
                            | (
                                ~models.Q(("start_source", "legacy"))
                                & models.Q(("livekit_room_sid__isnull", False))
                            )
                        ),
                        name="session_legacy_sid_consistent",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="MeetingParticipation",
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
                    "livekit_participant_sid",
                    models.CharField(
                        max_length=64, verbose_name="LiveKit participant SID"
                    ),
                ),
                (
                    "identity",
                    models.CharField(
                        db_index=True,
                        max_length=255,
                        verbose_name="participant identity",
                    ),
                ),
                (
                    "display_name",
                    models.CharField(
                        blank=True,
                        default="",
                        max_length=128,
                        verbose_name="display name",
                    ),
                ),
                (
                    "kind",
                    models.CharField(
                        default="unknown",
                        max_length=32,
                        verbose_name="participant kind",
                    ),
                ),
                (
                    "joined_at",
                    models.DateTimeField(db_index=True, verbose_name="joined at"),
                ),
                (
                    "left_at",
                    models.DateTimeField(
                        blank=True,
                        db_index=True,
                        null=True,
                        verbose_name="left at",
                    ),
                ),
                (
                    "disconnect_reason",
                    models.CharField(
                        blank=True,
                        default="",
                        max_length=48,
                        verbose_name="disconnect reason",
                    ),
                ),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="participations",
                        to="core.meetingsession",
                        verbose_name="meeting session",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="meeting_participations",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="user",
                    ),
                ),
            ],
            options={
                "verbose_name": "meeting participation",
                "verbose_name_plural": "meeting participations",
                "db_table": "meet_meeting_participation",
                "ordering": ("session", "joined_at"),
                "indexes": [
                    models.Index(
                        fields=["session", "joined_at"],
                        name="meet_part_sess_join_idx",
                    ),
                    models.Index(
                        fields=["user", "session"],
                        name="meet_part_user_sess_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("session", "livekit_participant_sid"),
                        name="uniq_session_participant_sid",
                    ),
                    models.CheckConstraint(
                        condition=(
                            models.Q(("left_at__isnull", True))
                            | models.Q(("left_at__gte", models.F("joined_at")))
                        ),
                        name="participation_leave_after_join",
                    ),
                ],
            },
        ),
    ]
