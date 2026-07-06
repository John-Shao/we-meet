# Hand-written for P3-M1 IM 稍后处理 (docs/features/foundation_p0_p3.md §P3-D2).

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0053_alter_auditlog_action_orginvitation'),
    ]

    operations = [
        migrations.CreateModel(
            name='ImLaterItem',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('cid', models.CharField(max_length=64, verbose_name='conversation id')),
                ('mid', models.CharField(max_length=32, verbose_name='message id')),
                ('seq', models.BigIntegerField(default=0, help_text='Conversation seq at mark time; reserved for jump-to-message.', verbose_name='message seq')),
                ('snippet', models.TextField(blank=True, default='', verbose_name='snippet')),
                ('sender_name', models.CharField(blank=True, default='', max_length=128, verbose_name='sender name')),
                ('content_type', models.CharField(blank=True, default='', max_length=32, verbose_name='content type')),
                ('done_at', models.DateTimeField(blank=True, null=True, verbose_name='done at')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='im_later_items', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'IM later item',
                'verbose_name_plural': 'IM later items',
                'db_table': 'meet_im_later_item',
                'ordering': ('-created_at',),
                'indexes': [models.Index(fields=['user', 'done_at'], name='imlater_user_done_idx')],
                'constraints': [models.UniqueConstraint(fields=('user', 'cid', 'mid'), name='one_later_per_user_message')],
            },
        ),
    ]
