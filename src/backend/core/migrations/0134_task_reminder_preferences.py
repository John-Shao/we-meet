from django.db import migrations, models


def normalize_task_reminder_preferences(apps, schema_editor):
    task_preference = apps.get_model("core", "TaskPreference")
    task_preference.objects.filter(default_reminder_minutes__in=(30, 60)).update(
        default_reminder_minutes=0
    )


def restore_legacy_task_reminder_preferences(apps, schema_editor):
    task_preference = apps.get_model("core", "TaskPreference")
    task_preference.objects.filter(default_reminder_minutes=0).update(
        default_reminder_minutes=30
    )
    task_preference.objects.filter(default_reminder_minutes=4320).update(
        default_reminder_minutes=1440
    )


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0133_task_preference"),
    ]

    operations = [
        migrations.RunPython(
            normalize_task_reminder_preferences,
            restore_legacy_task_reminder_preferences,
        ),
        migrations.AlterField(
            model_name="taskpreference",
            name="default_reminder_minutes",
            field=models.PositiveSmallIntegerField(
                default=0,
                verbose_name="default reminder minutes",
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
                    ("due_soon", "Due soon"),
                    ("due_today", "Due today"),
                    ("overdue", "Overdue"),
                ],
                max_length=16,
                verbose_name="event",
            ),
        ),
    ]
