# M 端 (management console) — audit log of administrative actions.

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0049_approval_multi_task'),
    ]

    operations = [
        migrations.CreateModel(
            name='AuditLog',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('action', models.CharField(choices=[('dept.create', 'Department created'), ('dept.rename', 'Department renamed'), ('dept.delete', 'Department deleted'), ('member.add', 'Member added'), ('member.update', 'Member updated'), ('member.role_change', 'Member role changed'), ('member.department_change', 'Member department changed'), ('member.suspend', 'Member suspended'), ('member.restore', 'Member restored'), ('member.remove', 'Member removed')], max_length=40)),
                ('target_type', models.CharField(blank=True, default='', help_text="The kind of object acted on, e.g. 'department' / 'membership'.", max_length=40)),
                ('target_id', models.CharField(blank=True, default='', help_text='Id of the object acted on.', max_length=64)),
                ('target_label', models.CharField(blank=True, default='', help_text='Human-readable name of the target at action time.', max_length=255)),
                ('metadata', models.JSONField(blank=True, default=dict, help_text='Action detail, e.g. before/after field values.')),
                ('actor', models.ForeignKey(blank=True, help_text='The admin who performed the action (null if since deleted).', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='audit_actions', to=settings.AUTH_USER_MODEL)),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='audit_logs', to='core.organization')),
            ],
            options={
                'verbose_name': 'Audit log',
                'verbose_name_plural': 'Audit logs',
                'db_table': 'meet_audit_log',
                'ordering': ('-created_at',),
            },
        ),
        migrations.AddIndex(
            model_name='auditlog',
            index=models.Index(fields=['organization', '-created_at'], name='meet_audit_org_created_idx'),
        ),
        migrations.AddIndex(
            model_name='auditlog',
            index=models.Index(fields=['actor', '-created_at'], name='meet_audit_actor_created_idx'),
        ),
    ]
