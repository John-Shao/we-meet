# Generated for the mobile app extension: Room meeting code and end timestamp.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0019_alter_user_language'),
    ]

    operations = [
        migrations.AddField(
            model_name='room',
            name='meeting_code',
            field=models.CharField(
                blank=True,
                help_text='Unique 6-digit numeric code used to join the room from apps.',
                max_length=6,
                null=True,
                unique=True,
                verbose_name='Room meeting code',
            ),
        ),
        migrations.AddField(
            model_name='room',
            name='ended_at',
            field=models.DateTimeField(
                blank=True,
                help_text='Date and time at which the room owner ended the room.',
                null=True,
                verbose_name='ended at',
            ),
        ),
    ]
