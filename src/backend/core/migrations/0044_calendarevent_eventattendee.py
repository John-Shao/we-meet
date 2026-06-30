# P2 — calendar / scheduling: CalendarEvent + EventAttendee (additive).

import django.db.models.deletion
import timezone_field.fields
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0043_user_im_uid'),
    ]

    operations = [
        migrations.CreateModel(
            name='CalendarEvent',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('title', models.CharField(max_length=255, verbose_name='title')),
                ('description', models.TextField(blank=True, default='', verbose_name='description')),
                ('start_at', models.DateTimeField(verbose_name='start at')),
                ('end_at', models.DateTimeField(verbose_name='end at')),
                ('timezone', timezone_field.fields.TimeZoneField(choices_display='WITH_GMT_OFFSET', default='UTC', help_text="The event's authoring timezone (for cross-tz display).", use_pytz=False, verbose_name='timezone')),
                ('all_day', models.BooleanField(default=False, verbose_name='all day')),
                ('status', models.CharField(choices=[('confirmed', 'Confirmed'), ('cancelled', 'Cancelled')], default='confirmed', max_length=20)),
                ('visibility', models.CharField(choices=[('default', 'Default'), ('private', 'Private')], default='default', max_length=20)),
                ('reminders', models.JSONField(blank=True, default=list, verbose_name='reminders')),
                ('reminder_pushed_at', models.DateTimeField(blank=True, help_text='Idempotency guard: set once the IM reminder has been sent.', null=True, verbose_name='reminder pushed at')),
                ('recurrence', models.CharField(blank=True, default='', help_text='RRULE string; empty means a single occurrence (MVP).', max_length=255, verbose_name='recurrence')),
                ('organizer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='organized_events', to=settings.AUTH_USER_MODEL)),
                ('room', models.ForeignKey(blank=True, help_text='The video room to join (created with the event); SET_NULL so the room + IM group outlive the event.', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='calendar_events', to='core.room')),
                ('recurrence_parent', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='occurrences', to='core.calendarevent')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='calendar_events', to='core.organization')),
            ],
            options={
                'verbose_name': 'Calendar event',
                'verbose_name_plural': 'Calendar events',
                'db_table': 'meet_calendar_event',
                'ordering': ('start_at',),
            },
        ),
        migrations.CreateModel(
            name='EventAttendee',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('email', models.CharField(blank=True, default='', max_length=255, verbose_name='email')),
                ('rsvp', models.CharField(choices=[('needs_action', 'Needs action'), ('accepted', 'Accepted'), ('declined', 'Declined'), ('tentative', 'Tentative')], default='needs_action', max_length=20)),
                ('role', models.CharField(choices=[('organizer', 'Organizer'), ('required', 'Required'), ('optional', 'Optional')], default='required', max_length=20)),
                ('event', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='attendees', to='core.calendarevent')),
                ('user', models.ForeignKey(blank=True, help_text='Internal attendee; null for an external email-only invite.', null=True, on_delete=django.db.models.deletion.CASCADE, related_name='event_attendances', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Event attendee',
                'verbose_name_plural': 'Event attendees',
                'db_table': 'meet_event_attendee',
                'ordering': ('created_at',),
            },
        ),
        migrations.AddIndex(
            model_name='calendarevent',
            index=models.Index(fields=['start_at'], name='calevent_start_idx'),
        ),
        migrations.AddConstraint(
            model_name='eventattendee',
            constraint=models.UniqueConstraint(fields=('event', 'user'), name='event_attendee_unique_event_user', violation_error_message='This user is already an attendee.'),
        ),
    ]
