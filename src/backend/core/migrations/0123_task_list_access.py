import uuid

import django.db.models.deletion
from django.db import migrations, models


def create_owner_accesses(apps, schema_editor):
    TaskList = apps.get_model("core", "TaskList")
    TaskListAccess = apps.get_model("core", "TaskListAccess")
    TaskListAccess.objects.bulk_create(
        [
            TaskListAccess(task_list_id=item.id, user_id=item.creator_id, role="owner")
            for item in TaskList.objects.exclude(creator_id=None).iterator()
        ],
        ignore_conflicts=True,
    )


class Migration(migrations.Migration):
    dependencies = [("core", "0122_task_list_groups")]

    operations = [
        migrations.CreateModel(
            name="TaskListAccess",
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
                    "role",
                    models.CharField(
                        choices=[
                            ("viewer", "Can view"),
                            ("editor", "Can edit"),
                            ("owner", "Owner"),
                        ],
                        max_length=16,
                        verbose_name="role",
                    ),
                ),
                (
                    "task_list",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="accesses",
                        to="core.tasklist",
                        verbose_name="task list",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="task_list_accesses",
                        to="core.user",
                        verbose_name="user",
                    ),
                ),
            ],
            options={
                "verbose_name": "task list access",
                "verbose_name_plural": "task list accesses",
                "db_table": "meet_task_list_access",
                "ordering": ("created_at", "id"),
            },
        ),
        migrations.AddConstraint(
            model_name="tasklistaccess",
            constraint=models.UniqueConstraint(
                fields=("task_list", "user"),
                name="task_list_access_unique_user",
            ),
        ),
        migrations.RunPython(create_owner_accesses, migrations.RunPython.noop),
    ]
