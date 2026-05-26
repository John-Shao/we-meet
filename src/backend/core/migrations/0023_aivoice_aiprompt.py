# Generated for the AI assistant feature: voice presets + prompt templates.
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0022_remove_room_meeting_code'),
    ]

    operations = [
        migrations.CreateModel(
            name='AIVoice',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('provider', models.CharField(choices=[('qwen', 'Qwen-Omni-Realtime'), ('doubao_s2s', 'Doubao S2S'), ('doubao', 'Doubao component pipeline')], max_length=32, verbose_name='provider')),
                ('value', models.CharField(help_text='The voice identifier sent to the provider API.', max_length=128, verbose_name='voice id')),
                ('label', models.CharField(help_text='Human-readable name shown in the UI.', max_length=128, verbose_name='display label')),
                ('sort_order', models.PositiveSmallIntegerField(default=0, verbose_name='sort order')),
                ('is_active', models.BooleanField(default=True, verbose_name='active')),
            ],
            options={
                'verbose_name': 'AI voice',
                'verbose_name_plural': 'AI voices',
                'ordering': ('provider', 'sort_order', 'label'),
                'unique_together': {('provider', 'value')},
            },
        ),
        migrations.CreateModel(
            name='AIPrompt',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('label', models.CharField(max_length=128, verbose_name='label')),
                ('content', models.TextField(verbose_name='content')),
                ('category', models.CharField(choices=[('general', 'General'), ('meeting', 'Meeting'), ('tutor', 'Tutor'), ('support', 'Support')], default='general', max_length=32, verbose_name='category')),
                ('sort_order', models.PositiveSmallIntegerField(default=0, verbose_name='sort order')),
                ('is_active', models.BooleanField(default=True, verbose_name='active')),
            ],
            options={
                'verbose_name': 'AI prompt',
                'verbose_name_plural': 'AI prompts',
                'ordering': ('category', 'sort_order', 'label'),
                'unique_together': {('category', 'label')},
            },
        ),
    ]
