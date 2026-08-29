import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0132_task_recurrence_key_task_recurrence_sequence_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="TaskPreference",
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
                    "daily_reminder_enabled",
                    models.BooleanField(
                        default=True, verbose_name="daily reminder enabled"
                    ),
                ),
                (
                    "overdue_marker_enabled",
                    models.BooleanField(
                        default=True, verbose_name="overdue marker enabled"
                    ),
                ),
                (
                    "default_reminder_minutes",
                    models.PositiveSmallIntegerField(
                        default=30,
                        verbose_name="default reminder minutes",
                    ),
                ),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="task_preference",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="user",
                    ),
                ),
            ],
            options={
                "verbose_name": "task preference",
                "verbose_name_plural": "task preferences",
                "db_table": "meet_task_preference",
            },
        ),
    ]
