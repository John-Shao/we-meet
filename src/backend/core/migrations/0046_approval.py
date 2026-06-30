# P5 — approval / workflow: ApprovalTemplate + ApprovalInstance + ApprovalTask.

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0045_meetingdoc'),
    ]

    operations = [
        migrations.CreateModel(
            name='ApprovalTemplate',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('name', models.CharField(max_length=255, verbose_name='name')),
                ('description', models.TextField(blank=True, default='', verbose_name='description')),
                ('form_schema', models.JSONField(blank=True, default=dict, verbose_name='form schema')),
                ('flow', models.JSONField(blank=True, default=list, help_text='Ordered approver-resolution rules; MVP is a serial chain.', verbose_name='flow')),
                ('is_active', models.BooleanField(default=True, verbose_name='active')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='approval_templates', to='core.organization')),
            ],
            options={
                'verbose_name': 'Approval template',
                'verbose_name_plural': 'Approval templates',
                'db_table': 'meet_approval_template',
                'ordering': ('name',),
            },
        ),
        migrations.CreateModel(
            name='ApprovalInstance',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('form_data', models.JSONField(blank=True, default=dict, verbose_name='form data')),
                ('status', models.CharField(choices=[('pending', 'Pending'), ('approved', 'Approved'), ('rejected', 'Rejected'), ('cancelled', 'Cancelled'), ('needs_assignment', 'Needs assignment')], default='pending', max_length=20)),
                ('current_node', models.PositiveIntegerField(default=0)),
                ('applicant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='approval_requests', to=settings.AUTH_USER_MODEL)),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='approval_instances', to='core.organization')),
                ('template', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='instances', to='core.approvaltemplate')),
            ],
            options={
                'verbose_name': 'Approval instance',
                'verbose_name_plural': 'Approval instances',
                'db_table': 'meet_approval_instance',
                'ordering': ('-created_at',),
            },
        ),
        migrations.CreateModel(
            name='ApprovalTask',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='primary key for the record as UUID', primary_key=True, serialize=False, verbose_name='id')),
                ('created_at', models.DateTimeField(auto_now_add=True, help_text='date and time at which a record was created', verbose_name='created on')),
                ('updated_at', models.DateTimeField(auto_now=True, help_text='date and time at which a record was last updated', verbose_name='updated on')),
                ('node_index', models.PositiveIntegerField()),
                ('action', models.CharField(choices=[('pending', 'Pending'), ('approved', 'Approved'), ('rejected', 'Rejected')], default='pending', max_length=20)),
                ('comment', models.TextField(blank=True, default='', verbose_name='comment')),
                ('acted_at', models.DateTimeField(blank=True, null=True)),
                ('approver', models.ForeignKey(blank=True, help_text='Resolved approver; null when the node could not be resolved.', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='approval_tasks', to=settings.AUTH_USER_MODEL)),
                ('instance', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='tasks', to='core.approvalinstance')),
            ],
            options={
                'verbose_name': 'Approval task',
                'verbose_name_plural': 'Approval tasks',
                'db_table': 'meet_approval_task',
                'ordering': ('instance', 'node_index'),
            },
        ),
        migrations.AddConstraint(
            model_name='approvaltask',
            constraint=models.UniqueConstraint(fields=('instance', 'node_index'), name='approval_task_unique_instance_node'),
        ),
    ]
