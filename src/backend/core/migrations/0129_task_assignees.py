from django.db import migrations, models


def copy_existing_assignees(apps, schema_editor):
    Task = apps.get_model("core", "Task")
    through = Task.assignees.through
    batch = []
    rows = (
        Task.objects.exclude(assignee_id=None)
        .values_list("id", "assignee_id")
        .iterator(chunk_size=2000)
    )
    for task_id, assignee_id in rows:
        batch.append(through(task_id=task_id, user_id=assignee_id))
        if len(batch) == 2000:
            through.objects.bulk_create(batch, ignore_conflicts=True)
            batch = []
    if batch:
        through.objects.bulk_create(batch, ignore_conflicts=True)


class Migration(migrations.Migration):
    dependencies = [("core", "0128_task_conversation_share")]

    operations = [
        migrations.AddField(
            model_name="task",
            name="assignees",
            field=models.ManyToManyField(
                blank=True,
                related_name="coassigned_tasks",
                to="core.user",
                verbose_name="assignees",
            ),
        ),
        migrations.RunPython(copy_existing_assignees, migrations.RunPython.noop),
    ]
