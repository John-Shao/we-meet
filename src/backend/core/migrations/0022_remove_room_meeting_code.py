# Generated to drop Room.meeting_code — the room's `slug` now serves as the
# 8-digit numeric meeting code, so the separate field is no longer needed.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0021_user_intro_avatar_cover'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='room',
            name='meeting_code',
        ),
    ]
