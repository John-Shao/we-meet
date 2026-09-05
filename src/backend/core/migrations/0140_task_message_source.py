import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0139_remove_legacy_task_saved_view_table")]

    operations = [
        migrations.CreateModel(
            name="TaskMessageSource",
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
                ("mid", models.CharField(max_length=32, verbose_name="message id")),
                ("seq", models.BigIntegerField(verbose_name="message seq")),
                (
                    "sender_uid",
                    models.CharField(max_length=128, verbose_name="sender user id"),
                ),
                (
                    "sent_at",
                    models.BigIntegerField(
                        help_text="Unix timestamp in milliseconds.",
                        verbose_name="message sent at",
                    ),
                ),
                (
                    "content_type",
                    models.CharField(max_length=32, verbose_name="content type"),
                ),
                (
                    "snapshot",
                    models.TextField(max_length=5000, verbose_name="message snapshot"),
                ),
                (
                    "task",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="message_source",
                        to="core.task",
                        verbose_name="task",
                    ),
                ),
            ],
            options={
                "verbose_name": "task message source",
                "verbose_name_plural": "task message sources",
                "db_table": "meet_task_message_source",
                "ordering": ("-created_at",),
                "indexes": [
                    models.Index(
                        fields=["cid", "mid"],
                        name="task_msg_source_cid_mid_idx",
                    )
                ],
            },
        ),
    ]
