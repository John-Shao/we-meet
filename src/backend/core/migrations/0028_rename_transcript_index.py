# Rename the Transcript (room, started_at) composite index from the
# manually-named ``core_transc_room_id_started_idx`` (32 chars — exceeds
# Django's 30-char limit) to the auto-generated short name that Django
# computes when no explicit name is given.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0027_transcript"),
    ]

    operations = [
        migrations.RenameIndex(
            model_name="transcript",
            new_name="core_transc_room_id_85e43a_idx",
            old_name="core_transc_room_id_started_idx",
        ),
    ]
