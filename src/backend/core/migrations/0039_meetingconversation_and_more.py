# P5: meeting ↔ jusi-light-im group bridge.
# The two un-related RenameIndex operations Django auto-detected on transcriptchunk
# are split into a sibling migration (0040) so this commit stays scoped to P5.

import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0038_seed_qwen_omni_voices'),
    ]

    operations = [
        migrations.CreateModel(
            name='MeetingConversation',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('cid', models.CharField(help_text='jusi-light-im conversation id (UUIDv5 from room id)', max_length=64, unique=True)),
                ('summary_pushed_at', models.DateTimeField(blank=True, help_text='set when the meeting summary has been posted as a system message to the conversation — read by the summary push hook to avoid duplicate sends', null=True)),
            ],
            options={
                'verbose_name': 'Meeting conversation',
                'verbose_name_plural': 'Meeting conversations',
                'db_table': 'meet_meeting_conversation',
            },
        ),
        migrations.AddField(
            model_name='meetingconversation',
            name='room',
            field=models.OneToOneField(blank=True, help_text='the meeting room this conversation was created for', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='im_conversation', to='core.room'),
        ),
    ]
