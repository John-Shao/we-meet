"""Retain authorization lifecycle history after the meeting room is deleted."""

import django.db.models.deletion
from django.db import migrations, models


def retain_room_id(apps, schema_editor):
    session = apps.get_model("core", "RemoteControlSession")
    session.objects.using(schema_editor.connection.alias).update(
        room_reference=models.F("room_id")
    )


class Migration(migrations.Migration):
    dependencies = [("core", "0223_remote_control_authorization")]

    operations = [
        migrations.AddField(
            model_name="remotecontrolsession",
            name="room_reference",
            field=models.UUIDField(db_index=True, editable=False, null=True),
        ),
        migrations.RunPython(retain_room_id, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="remotecontrolsession",
            name="room_reference",
            field=models.UUIDField(db_index=True, editable=False),
        ),
        migrations.AlterField(
            model_name="remotecontrolsession",
            name="room",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                to="core.room",
            ),
        ),
    ]
