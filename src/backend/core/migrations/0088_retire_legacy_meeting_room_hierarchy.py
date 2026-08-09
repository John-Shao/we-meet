from django.db import migrations
from django.utils import timezone


def retire_legacy_hierarchy(apps, schema_editor):
    """Hide arbitrary-depth locations without destroying booking history."""
    now = timezone.now()
    MeetingRoom = apps.get_model("core", "MeetingRoom")
    MeetingRoomNode = apps.get_model("core", "MeetingRoomNode")

    MeetingRoom.objects.filter(deleted_at__isnull=True).update(
        deleted_at=now,
        is_active=False,
    )
    MeetingRoomNode.objects.filter(deleted_at__isnull=True).update(
        deleted_at=now,
        is_active=False,
    )


class Migration(migrations.Migration):
    dependencies = [("core", "0087_delete_imdraft")]

    operations = [
        migrations.RunPython(retire_legacy_hierarchy, migrations.RunPython.noop),
    ]
