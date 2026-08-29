import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models.functions import Lower


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0135_task_reminder_preference"),
    ]

    operations = [
        migrations.CreateModel(
            name="TaskSavedView",
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
                ("name", models.CharField(max_length=80, verbose_name="name")),
                (
                    "config",
                    models.JSONField(default=dict, verbose_name="configuration"),
                ),
                (
                    "position",
                    models.PositiveIntegerField(default=0, verbose_name="position"),
                ),
                ("is_pinned", models.BooleanField(default=True, verbose_name="pinned")),
                (
                    "is_default",
                    models.BooleanField(default=False, verbose_name="default"),
                ),
                (
                    "organization",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="task_saved_views",
                        to="core.organization",
                        verbose_name="organization",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="task_saved_views",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="owner",
                    ),
                ),
            ],
            options={
                "verbose_name": "task saved view",
                "verbose_name_plural": "task saved views",
                "db_table": "meet_task_saved_view",
                "ordering": ("position", "created_at", "id"),
                "indexes": [
                    models.Index(
                        fields=["organization", "owner", "is_pinned", "position"],
                        name="task_saved_view_nav_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        Lower("name"),
                        "organization",
                        "owner",
                        name="task_saved_view_name_ci_uniq",
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(("is_default", True)),
                        fields=("organization", "owner"),
                        name="task_saved_view_default_uniq",
                    ),
                ],
            },
        ),
    ]
