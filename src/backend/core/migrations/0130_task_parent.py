import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0129_task_assignees")]

    operations = [
        migrations.AddField(
            model_name="task",
            name="parent",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="subtasks",
                to="core.task",
                verbose_name="parent task",
            ),
        ),
        migrations.AddIndex(
            model_name="task",
            index=models.Index(
                fields=["organization", "parent", "position"],
                name="task_org_parent_pos_idx",
            ),
        ),
    ]
