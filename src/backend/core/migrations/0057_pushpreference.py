# Hand-written for P0-M3 免打扰时段 (docs/features/foundation_p0_p3.md §P0).

import datetime
import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0056_user_phone'),
    ]

    operations = [
        migrations.CreateModel(
            name='PushPreference',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('quiet_enabled', models.BooleanField(default=False, verbose_name='quiet hours enabled')),
                ('quiet_start', models.TimeField(default=datetime.time(22, 0), verbose_name='quiet start')),
                ('quiet_end', models.TimeField(default=datetime.time(8, 0), verbose_name='quiet end')),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='push_preference', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'push preference',
                'verbose_name_plural': 'push preferences',
                'db_table': 'meet_push_preference',
            },
        ),
    ]
