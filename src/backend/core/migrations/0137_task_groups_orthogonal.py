import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def backfill_task_group_scope(apps, schema_editor):
    TaskGroup = apps.get_model("core", "TaskGroup")
    for group in TaskGroup.objects.select_related("task_list").iterator():
        group.organization_id = group.task_list.organization_id
        group.creator_id = group.task_list.creator_id
        group.save(update_fields=["organization_id", "creator_id"])


class Migration(migrations.Migration):
    dependencies = [("core", "0136_task_saved_view")]

    operations = [
        migrations.AddField(
            model_name="taskgroup",
            name="organization",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="task_groups",
                to="core.organization",
                verbose_name="organization",
            ),
        ),
        migrations.AddField(
            model_name="taskgroup",
            name="creator",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="created_task_groups",
                to=settings.AUTH_USER_MODEL,
                verbose_name="creator",
            ),
        ),
        migrations.RunPython(backfill_task_group_scope, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="taskgroup",
            name="organization",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="task_groups",
                to="core.organization",
                verbose_name="organization",
            ),
        ),
        migrations.AlterField(
            model_name="taskgroup",
            name="task_list",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="groups",
                to="core.tasklist",
                verbose_name="task list",
            ),
        ),
    ]
