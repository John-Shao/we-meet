import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0127_task_followers")]

    operations = [
        migrations.CreateModel(
            name="TaskConversationShare",
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
                    "cid",
                    models.CharField(
                        db_index=True,
                        max_length=64,
                        verbose_name="conversation id",
                    ),
                ),
                (
                    "shared_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="shared_task_cards",
                        to="core.user",
                        verbose_name="shared by",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="conversation_shares",
                        to="core.task",
                        verbose_name="task",
                    ),
                ),
            ],
            options={
                "verbose_name": "task conversation share",
                "verbose_name_plural": "task conversation shares",
                "db_table": "meet_task_conversation_share",
                "ordering": ("-created_at",),
                "indexes": [
                    models.Index(
                        fields=["cid", "-created_at"],
                        name="task_share_cid_created_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("task", "cid"),
                        name="one_task_share_per_conversation",
                    )
                ],
            },
        )
    ]
