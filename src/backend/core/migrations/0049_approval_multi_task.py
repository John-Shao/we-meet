# P5b — approval advanced: allow several tasks per node (会签/抄送), add task kind,
# extend action choices (skipped/notified). Additive; single-mode flows unaffected.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0048_approvaldelegation'),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name='approvaltask',
            name='approval_task_unique_instance_node',
        ),
        migrations.AddField(
            model_name='approvaltask',
            name='kind',
            field=models.CharField(
                choices=[('approve', 'Approval'), ('cc', 'Carbon copy')],
                default='approve',
                max_length=20,
            ),
        ),
        migrations.AlterField(
            model_name='approvaltask',
            name='action',
            field=models.CharField(
                choices=[
                    ('pending', 'Pending'),
                    ('approved', 'Approved'),
                    ('rejected', 'Rejected'),
                    ('skipped', 'Skipped'),
                    ('notified', 'Notified'),
                ],
                default='pending',
                max_length=20,
            ),
        ),
        migrations.AddConstraint(
            model_name='approvaltask',
            constraint=models.UniqueConstraint(
                fields=('instance', 'node_index', 'approver'),
                name='approval_task_unique_instance_node_approver',
            ),
        ),
    ]
