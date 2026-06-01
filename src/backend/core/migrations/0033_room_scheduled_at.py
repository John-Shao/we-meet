from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0032_alter_room_access_level_default_trusted"),
    ]

    operations = [
        migrations.AddField(
            model_name="room",
            name="scheduled_at",
            field=models.DateTimeField(
                blank=True,
                null=True,
                help_text=(
                    "Date and time at which the room is scheduled to start. "
                    "Informational only — the room is reachable as soon as "
                    "it's created, but UIs (lobby, history) surface this "
                    "value as the intended start so participants know when "
                    "to show up."
                ),
                verbose_name="scheduled for",
            ),
        ),
    ]
