# Sprint 2.2.a: Summary + ActionItem tables. Vector / embedding rows are
# deferred to a later migration once pgvector is enabled on the database.
import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0029_transcript_translations"),
    ]

    operations = [
        migrations.CreateModel(
            name="Summary",
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
                ("content", models.TextField(blank=True, default="", verbose_name="content")),
                (
                    "model_used",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="LLM endpoint / model identifier that produced this summary.",
                        max_length=128,
                        verbose_name="model used",
                    ),
                ),
                (
                    "transcripts_count",
                    models.PositiveIntegerField(
                        default=0,
                        help_text=(
                            "How many Transcript rows fed into this summary. Useful for "
                            "detecting when the summary went stale and needs a regen."
                        ),
                        verbose_name="transcripts count",
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("success", "Success"),
                            ("failed", "Failed"),
                        ],
                        default="pending",
                        max_length=16,
                        verbose_name="status",
                    ),
                ),
                (
                    "error_message",
                    models.TextField(blank=True, default="", verbose_name="error message"),
                ),
                (
                    "room",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="summary",
                        to="core.room",
                        verbose_name="room",
                    ),
                ),
            ],
            options={
                "verbose_name": "meeting summary",
                "verbose_name_plural": "meeting summaries",
                "ordering": ("-updated_at",),
            },
        ),
        migrations.CreateModel(
            name="ActionItem",
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
                ("content", models.TextField(verbose_name="content")),
                (
                    "owner_text",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "Free-text owner as extracted by the LLM (e.g. 'John', '王总', "
                            "'frontend team'). Not FK to User — matching is fuzzy at best."
                        ),
                        max_length=128,
                        verbose_name="owner",
                    ),
                ),
                (
                    "due_text",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="Free-text deadline (e.g. '下周五', 'before EOQ').",
                        max_length=128,
                        verbose_name="due",
                    ),
                ),
                (
                    "sort_order",
                    models.PositiveSmallIntegerField(default=0, verbose_name="sort order"),
                ),
                ("is_completed", models.BooleanField(default=False, verbose_name="completed")),
                (
                    "room",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="action_items",
                        to="core.room",
                        verbose_name="room",
                    ),
                ),
                (
                    "summary",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="action_items",
                        to="core.summary",
                        verbose_name="summary",
                    ),
                ),
                (
                    "source_transcript",
                    models.ForeignKey(
                        blank=True,
                        help_text=(
                            "Transcript row the LLM cited as the source for this action item, "
                            "if any. Optional — many items synthesise across multiple lines."
                        ),
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="action_items",
                        to="core.transcript",
                        verbose_name="source transcript",
                    ),
                ),
            ],
            options={
                "verbose_name": "action item",
                "verbose_name_plural": "action items",
                "ordering": ("room", "sort_order", "created_at"),
            },
        ),
    ]
