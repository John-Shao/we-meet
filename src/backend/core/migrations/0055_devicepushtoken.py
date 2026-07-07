# Hand-written for P0 离线推送 (docs/features/foundation_p0_p3.md §P0).

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0054_imlateritem'),
    ]

    operations = [
        migrations.CreateModel(
            name='DevicePushToken',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('provider', models.CharField(choices=[('getui', 'Getui')], default='getui', max_length=16, verbose_name='provider')),
                ('cid', models.CharField(max_length=128, verbose_name='push client id')),
                ('device_id', models.CharField(blank=True, default='', max_length=128, verbose_name='device id')),
                ('platform', models.CharField(blank=True, default='', max_length=16, verbose_name='platform')),
                ('app_version', models.CharField(blank=True, default='', max_length=32, verbose_name='app version')),
                ('last_seen_at', models.DateTimeField(blank=True, null=True, verbose_name='last seen at')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='push_tokens', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'device push token',
                'verbose_name_plural': 'device push tokens',
                'db_table': 'meet_device_push_token',
                'ordering': ('-updated_at',),
                'indexes': [models.Index(fields=['user'], name='pushtoken_user_idx')],
                'constraints': [models.UniqueConstraint(fields=('provider', 'cid'), name='one_row_per_provider_cid')],
            },
        ),
    ]
