# Hand-written for 纪要闭环 P0-3 M2 (docs/features/meeting_summary_closure.md §D3).

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0059_summarychapter'),
    ]

    operations = [
        migrations.AddField(
            model_name='summary',
            name='edited_content',
            field=models.TextField(blank=True, default='', verbose_name='edited content'),
        ),
        migrations.AddField(
            model_name='summary',
            name='edited_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='edited_summaries', to=settings.AUTH_USER_MODEL, verbose_name='edited by'),
        ),
        migrations.AddField(
            model_name='summary',
            name='edited_at',
            field=models.DateTimeField(blank=True, null=True, verbose_name='edited at'),
        ),
        migrations.AddField(
            model_name='summary',
            name='content_generated_at',
            field=models.DateTimeField(blank=True, null=True, verbose_name='content generated at'),
        ),
        migrations.AlterField(
            model_name='auditlog',
            name='action',
            field=models.CharField(choices=[('dept.create', 'Department created'), ('dept.rename', 'Department renamed'), ('dept.update', 'Department updated'), ('dept.move', 'Department moved'), ('dept.delete', 'Department deleted'), ('member.add', 'Member added'), ('member.invite', 'Member invited'), ('member.invite_revoke', 'Member invitation revoked'), ('member.update', 'Member updated'), ('member.role_change', 'Member role changed'), ('member.department_change', 'Member department changed'), ('member.suspend', 'Member suspended'), ('member.restore', 'Member restored'), ('member.remove', 'Member removed'), ('summary.edit', 'Meeting summary edited')], max_length=40),
        ),
    ]
