# P3 — collaborative docs: MeetingDoc (Room ↔ La Suite Docs document link).

import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0044_calendarevent_eventattendee'),
    ]

    operations = [
        migrations.CreateModel(
            name='MeetingDoc',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('doc_id', models.CharField(help_text='La Suite Docs document id', max_length=64, unique=True)),
                ('doc_url', models.URLField(help_text='deep link to the document on the Docs site', max_length=512)),
                ('room', models.OneToOneField(blank=True, help_text='the meeting room this document was created for', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='meeting_doc', to='core.room')),
            ],
            options={
                'verbose_name': 'Meeting document',
                'verbose_name_plural': 'Meeting documents',
                'db_table': 'meet_meeting_doc',
            },
        ),
    ]
