# Generated for the mobile app extension: User intro / avatar / cover fields.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0020_room_meeting_code_ended_at'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='intro',
            field=models.CharField(
                blank=True,
                default='',
                help_text="Short self-introduction shown on the user's profile.",
                max_length=100,
                verbose_name='intro',
            ),
        ),
        migrations.AddField(
            model_name='user',
            name='avatar_key',
            field=models.CharField(
                blank=True,
                default='',
                help_text="Object storage key of the user's avatar image.",
                max_length=500,
                verbose_name='avatar object key',
            ),
        ),
        migrations.AddField(
            model_name='user',
            name='cover_key',
            field=models.CharField(
                blank=True,
                default='',
                help_text="Object storage key of the user's profile cover image.",
                max_length=500,
                verbose_name='cover object key',
            ),
        ),
    ]
