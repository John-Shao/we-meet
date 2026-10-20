# Generated for cross-client AI conversation sync.

import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0228_bilingual_session"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AIConversation",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("client_id", models.CharField(max_length=128)),
                ("device_id", models.CharField(blank=True, max_length=128)),
                ("kind", models.CharField(choices=[("call", "AI call"), ("chat", "AI chat"), ("translation", "Assistant translation")], default="call", max_length=16)),
                ("title", models.CharField(blank=True, max_length=200)),
                ("started_at", models.DateTimeField()),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                ("status", models.CharField(choices=[("ongoing", "Ongoing"), ("completed", "Completed"), ("interrupted", "Interrupted"), ("error", "Error")], default="completed", max_length=16)),
                ("summary", models.TextField(blank=True)),
                ("todos", models.JSONField(blank=True, default=list)),
                ("version", models.PositiveBigIntegerField(default=1)),
                ("deleted_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="ai_conversations", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "ordering": ["-started_at", "-id"],
                "indexes": [
                    models.Index(fields=["owner", "deleted_at", "started_at"], name="ai_conv_owner_list"),
                    models.Index(fields=["owner", "updated_at"], name="ai_conv_owner_sync"),
                ],
                "constraints": [
                    models.UniqueConstraint(fields=("owner", "client_id"), name="ai_conversation_client_once"),
                ],
            },
        ),
        migrations.CreateModel(
            name="AIConversationMessage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("client_id", models.CharField(max_length=128)),
                ("position", models.PositiveIntegerField()),
                ("role", models.CharField(choices=[("user", "User"), ("assistant", "Assistant"), ("system", "System")], max_length=16)),
                ("text", models.TextField()),
                ("source", models.CharField(blank=True, max_length=20)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("conversation", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="messages", to="core.aiconversation")),
            ],
            options={
                "ordering": ["position", "id"],
                "indexes": [
                    models.Index(fields=["conversation", "position"], name="ai_msg_conv_order"),
                ],
                "constraints": [
                    models.UniqueConstraint(fields=("conversation", "client_id"), name="ai_message_client_once"),
                ],
            },
        ),
    ]
