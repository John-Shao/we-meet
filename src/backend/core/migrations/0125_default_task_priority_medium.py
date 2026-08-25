from django.db import migrations, models


def backfill_medium_priority(apps, schema_editor):
    task_model = apps.get_model("core", "Task")
    task_model.objects.filter(priority="none").update(priority="medium")


class Migration(migrations.Migration):
    dependencies = [("core", "0124_remove_task_parent")]

    operations = [
        migrations.RunPython(backfill_medium_priority, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="task",
            name="priority",
            field=models.CharField(
                choices=[
                    ("none", "No priority"),
                    ("low", "Low"),
                    ("medium", "Medium"),
                    ("high", "High"),
                    ("urgent", "Urgent"),
                ],
                db_index=True,
                default="medium",
                max_length=16,
                verbose_name="priority",
            ),
        ),
    ]
