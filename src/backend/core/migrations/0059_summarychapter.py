# Hand-written for 纪要闭环 P0-3 M1 (docs/features/meeting_summary_closure.md §D1).

import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0058_calendarevent_recurrence_exdates_and_uniq'),
    ]

    operations = [
        migrations.CreateModel(
            name='SummaryChapter',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('title', models.CharField(max_length=200, verbose_name='title')),
                ('digest', models.TextField(blank=True, default='', help_text='1-3 sentence gist of this chapter.', verbose_name='digest')),
                ('started_at', models.DateTimeField(blank=True, null=True, verbose_name='started at')),
                ('ended_at', models.DateTimeField(blank=True, null=True, verbose_name='ended at')),
                ('sort_order', models.PositiveSmallIntegerField(default=0, verbose_name='sort order')),
                ('room', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='summary_chapters', to='core.room', verbose_name='room')),
                ('summary', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='chapters', to='core.summary', verbose_name='summary')),
            ],
            options={
                'verbose_name': 'summary chapter',
                'verbose_name_plural': 'summary chapters',
                'db_table': 'meet_summary_chapter',
                'ordering': ('room', 'sort_order', 'created_at'),
            },
        ),
    ]
