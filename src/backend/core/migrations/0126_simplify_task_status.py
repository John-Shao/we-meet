from django.db import migrations, models


def reopen_legacy_task_statuses(apps, schema_editor):
    task_model = apps.get_model("core", "Task")
    task_model.objects.filter(status__in=["in_progress", "canceled"]).update(
        status="todo",
        completed_at=None,
    )


class Migration(migrations.Migration):
    dependencies = [("core", "0125_default_task_priority_medium")]

    operations = [
        migrations.RunPython(
            reopen_legacy_task_statuses,
            migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name="task",
            name="status",
            field=models.CharField(
                choices=[("todo", "To do"), ("completed", "Completed")],
                db_index=True,
                default="todo",
                max_length=16,
                verbose_name="status",
            ),
        ),
    ]
