# Speaker identity presentation and audit foundation (2026-10-10 Asia/Shanghai).

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


def backfill_members(apps, schema_editor):
    speaker = apps.get_model("core", "MeetingSpeaker")
    speaker.objects.using(schema_editor.connection.alias).filter(
        user__isnull=False
    ).update(attribution_kind="member")


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0199_manage_assistant_prompts'),
    ]

    operations = [
        migrations.CreateModel(
            name='SpeakerIdentityDecision',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('action', models.CharField(max_length=32)),
                ('previous_user_id', models.UUIDField(blank=True, null=True)),
                ('selected_user_id', models.UUIDField(blank=True, null=True)),
                ('previous_label', models.CharField(blank=True, max_length=128)),
                ('selected_label', models.CharField(blank=True, max_length=128)),
                ('previous_kind', models.CharField(max_length=16)),
                ('selected_kind', models.CharField(max_length=16)),
                ('record_revision', models.PositiveIntegerField()),
            ],
        ),
        migrations.AddField(
            model_name='meetingspeaker',
            name='attribution_kind',
            field=models.CharField(choices=[('none', 'None'), ('member', 'Member'), ('contact', 'Contact'), ('custom', 'Custom')], default='none', max_length=16),
        ),
        migrations.AddField(
            model_name='meetingspeaker',
            name='contact_source',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='speaker_snapshots', to='core.externalcontact'),
        ),
        migrations.AddField(
            model_name='meetingspeaker',
            name='manual_label',
            field=models.CharField(blank=True, default='', max_length=128),
        ),
        migrations.AddConstraint(
            model_name='meetingspeaker',
            constraint=models.CheckConstraint(condition=models.Q(('user__isnull', True), ('manual_label', ''), _connector='OR'), name='speaker_member_label_exclusive'),
        ),
        migrations.AddField(
            model_name='speakeridentitydecision',
            name='actor',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='speakeridentitydecision',
            name='record',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='identity_decisions', to='core.meetingrecord'),
        ),
        migrations.AddField(
            model_name='speakeridentitydecision',
            name='speaker',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='identity_decisions', to='core.meetingspeaker'),
        ),
        migrations.AddConstraint(
            model_name='speakeridentitydecision',
            constraint=models.UniqueConstraint(fields=('record', 'record_revision'), name='identity_decision_revision'),
        ),
        migrations.RunPython(backfill_members, migrations.RunPython.noop),
    ]
