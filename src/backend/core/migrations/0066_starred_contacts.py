import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0065_alter_auditlog_action_meeting_rooms'),
    ]

    operations = [
        migrations.AddField(
            model_name='pushpreference',
            name='starred_bypass_quiet',
            field=models.BooleanField(default=True, help_text='Messages from a starred contact (see StarredContact) still push during quiet hours. Default on: starring someone is already an explicit act, so it should mean something without a second opt-in.', verbose_name='starred contacts bypass quiet hours'),
        ),
        migrations.CreateModel(
            name='StarredContact',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('owner', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='starred_contacts', to=settings.AUTH_USER_MODEL)),
                ('target', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='starred_by', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'starred contact',
                'verbose_name_plural': 'starred contacts',
                'db_table': 'meet_starred_contact',
                'ordering': ('created_at',),
                'indexes': [models.Index(fields=['target', 'owner'], name='starred_target_owner_idx')],
                'constraints': [models.UniqueConstraint(fields=('owner', 'target'), name='one_star_per_owner_target')],
            },
        ),
    ]
