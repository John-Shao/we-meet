import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0126_simplify_task_status")]

    operations = [
        migrations.AddField(
            model_name="task",
            name="followers",
            field=models.ManyToManyField(
                blank=True,
                related_name="followed_tasks",
                to="core.user",
                verbose_name="followers",
            ),
        ),
        migrations.AlterField(
            model_name="taskimdelivery",
            name="task",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="im_deliveries",
                to="core.task",
                verbose_name="task",
            ),
        ),
        migrations.AddField(
            model_name="taskimdelivery",
            name="task_title",
            field=models.TextField(blank=True, default="", verbose_name="task title"),
        ),
        migrations.AddField(
            model_name="taskimdelivery",
            name="actor_name",
            field=models.CharField(
                blank=True, default="", max_length=255, verbose_name="actor name"
            ),
        ),
        migrations.AlterField(
            model_name="taskimdelivery",
            name="event",
            field=models.CharField(
                choices=[
                    ("assigned", "Assigned"),
                    ("reassigned", "Reassigned"),
                    ("commented", "Commented"),
                    ("dates_changed", "Dates changed"),
                    ("status_changed", "Status changed"),
                    ("priority_changed", "Priority changed"),
                    ("deleted", "Deleted"),
                    ("starting", "Starting"),
                    ("due_today", "Due today"),
                    ("overdue", "Overdue"),
                ],
                max_length=16,
                verbose_name="event",
            ),
        ),
    ]
