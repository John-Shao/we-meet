# P5 — approval delegation: delegate a user's approval tasks for a time window.

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0047_delete_useraipreference'),
    ]

    operations = [
        migrations.CreateModel(
            name='ApprovalDelegation',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('start_at', models.DateTimeField()),
                ('end_at', models.DateTimeField()),
                ('is_active', models.BooleanField(default=True)),
                ('delegate', models.ForeignKey(help_text="Who acts on the delegator's behalf.", on_delete=django.db.models.deletion.CASCADE, related_name='approval_delegations_in', to=settings.AUTH_USER_MODEL)),
                ('delegator', models.ForeignKey(help_text='Whose approval tasks are handed off.', on_delete=django.db.models.deletion.CASCADE, related_name='approval_delegations_out', to=settings.AUTH_USER_MODEL)),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='approval_delegations', to='core.organization')),
            ],
            options={
                'verbose_name': 'Approval delegation',
                'verbose_name_plural': 'Approval delegations',
                'db_table': 'meet_approval_delegation',
                'ordering': ('-start_at',),
            },
        ),
    ]
