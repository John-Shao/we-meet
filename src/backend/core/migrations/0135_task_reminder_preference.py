import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0134_task_reminder_preferences"),
    ]

    operations = [
        migrations.CreateModel(
            name="TaskReminderPreference",
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
                ("enabled", models.BooleanField(default=True, verbose_name="enabled")),
                (
                    "reminder_minutes",
                    models.PositiveSmallIntegerField(
                        blank=True,
                        choices=[
                            (0, "On due date"),
                            (1440, "One day before"),
                            (4320, "Three days before"),
                        ],
                        help_text="Empty follows the user's default task reminder.",
                        null=True,
                        verbose_name="reminder minutes",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="reminder_preferences",
                        to="core.task",
                        verbose_name="task",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="task_reminder_preferences",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="user",
                    ),
                ),
            ],
            options={
                "verbose_name": "task reminder preference",
                "verbose_name_plural": "task reminder preferences",
                "db_table": "meet_task_reminder_preference",
                "constraints": [
                    models.UniqueConstraint(
                        fields=("task", "user"),
                        name="task_reminder_preference_task_user_uniq",
                    )
                ],
            },
        ),
    ]
