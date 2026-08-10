from django.db import migrations, models


def reset_meeting_room_locations(apps, schema_editor):
    """Drop development room data before installing the new location shape."""
    MeetingRoom = apps.get_model("core", "MeetingRoom")
    MeetingRoomNode = apps.get_model("core", "MeetingRoomNode")

    # Deleting rooms cascades to their bookings but leaves calendar events intact.
    MeetingRoom.objects.all().delete()
    # The previous hierarchy was already retired by 0088. Rebuild all four
    # levels so no hidden arbitrary-depth nodes survive into the new shape.
    MeetingRoomNode.objects.all().delete()


class Migration(migrations.Migration):
    # PostgreSQL cannot ALTER the room table while the preceding deletes still
    # have deferred foreign-key trigger events in the same transaction. Keep
    # the data reset and schema change on separate autocommit boundaries.
    atomic = False

    dependencies = [("core", "0088_retire_legacy_meeting_room_hierarchy")]

    operations = [
        migrations.RunPython(reset_meeting_room_locations, migrations.RunPython.noop),
        migrations.AddField(
            model_name="meetingroom",
            name="floor",
            field=models.CharField(max_length=32, verbose_name="floor"),
        ),
    ]
