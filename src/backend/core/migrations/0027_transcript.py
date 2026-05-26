# Transcript table: one row per FINAL_TRANSCRIPT event from the
# multi_user_transcriber agent. Data source for RAG and downstream
# summary / action-item extraction.
import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0026_drop_legacy_ai_columns"),
    ]

    operations = [
        migrations.CreateModel(
            name="Transcript",
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
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                (
                    "speaker_identity",
                    models.CharField(
                        db_index=True,
                        help_text="LiveKit participant.identity at the time of speaking.",
                        max_length=128,
                        verbose_name="speaker identity",
                    ),
                ),
                (
                    "speaker_name",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="LiveKit participant.name (display name) at the time of speaking.",
                        max_length=128,
                        verbose_name="speaker name",
                    ),
                ),
                ("text", models.TextField(verbose_name="text")),
                (
                    "language",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="ISO 639-1 language code reported by the STT engine.",
                        max_length=16,
                        verbose_name="language",
                    ),
                ),
                (
                    "started_at",
                    models.DateTimeField(db_index=True, verbose_name="speech started at"),
                ),
                (
                    "ended_at",
                    models.DateTimeField(blank=True, null=True, verbose_name="speech ended at"),
                ),
                (
                    "room",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="transcripts",
                        to="core.room",
                        verbose_name="room",
                    ),
                ),
            ],
            options={
                "verbose_name": "transcript",
                "verbose_name_plural": "transcripts",
                "ordering": ("room", "started_at"),
                "indexes": [
                    models.Index(fields=["room", "started_at"], name="core_transc_room_id_started_idx"),
                ],
            },
        ),
    ]
