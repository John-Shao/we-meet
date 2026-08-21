"""Seed the built-in Task Assistant identity."""

import uuid

from django.db import migrations

BOT_SLUG = "task-assistant"
BOT_ID = uuid.uuid5(uuid.NAMESPACE_OID, f"we-meet:builtin-bot:{BOT_SLUG}")


def seed_task_assistant(apps, schema_editor):
    """Create the global identity without making deployment-time IM calls."""

    ImBot = apps.get_model("core", "ImBot")
    ImBot.objects.get_or_create(
        id=BOT_ID,
        defaults={
            "kind": "builtin",
            "slug": BOT_SLUG,
            "name": "任务助手",
            "description": "任务分派与进度通知",
            "avatar_color_index": 6,
            "organization": None,
            "is_active": True,
        },
    )


def unseed_task_assistant(apps, schema_editor):
    """Remove only the deterministic identity introduced by this migration."""

    ImBot = apps.get_model("core", "ImBot")
    ImBot.objects.filter(id=BOT_ID).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0108_taskcomment"),
    ]

    operations = [
        migrations.RunPython(seed_task_assistant, reverse_code=unseed_task_assistant),
    ]
