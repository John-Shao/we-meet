from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0130_task_parent")]

    operations = [
        migrations.AlterField(
            model_name="taskactivity",
            name="event",
            field=models.CharField(
                choices=[
                    ("created", "Created"),
                    ("content_changed", "Content changed"),
                    ("dates_changed", "Dates changed"),
                    ("assignee_changed", "Assignee changed"),
                    ("status_changed", "Status changed"),
                    ("priority_changed", "Priority changed"),
                    ("placement_changed", "Placement changed"),
                    ("hierarchy_changed", "Hierarchy changed"),
                    ("attachment_removed", "Attachment removed"),
                    ("source_action_item_changed", "Source action item changed"),
                ],
                max_length=32,
                verbose_name="event",
            ),
        ),
    ]
