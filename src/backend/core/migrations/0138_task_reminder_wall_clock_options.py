from django.db import migrations, models

FORWARD_VALUES = {
    0: 900,
    1440: 2340,
    4320: 5220,
}
REVERSE_VALUES = {
    360: 0,
    900: 0,
    2340: 1440,
    3780: 1440,
    5220: 4320,
}


def migrate_reminder_values(apps, schema_editor):
    TaskPreference = apps.get_model("core", "TaskPreference")
    TaskReminderPreference = apps.get_model("core", "TaskReminderPreference")
    for old_value, new_value in FORWARD_VALUES.items():
        TaskPreference.objects.filter(default_reminder_minutes=old_value).update(
            default_reminder_minutes=new_value
        )
        TaskReminderPreference.objects.filter(reminder_minutes=old_value).update(
            reminder_minutes=new_value
        )


def reverse_reminder_values(apps, schema_editor):
    TaskPreference = apps.get_model("core", "TaskPreference")
    TaskReminderPreference = apps.get_model("core", "TaskReminderPreference")
    for new_value, old_value in REVERSE_VALUES.items():
        TaskPreference.objects.filter(default_reminder_minutes=new_value).update(
            default_reminder_minutes=old_value
        )
        TaskReminderPreference.objects.filter(reminder_minutes=new_value).update(
            reminder_minutes=old_value
        )


class Migration(migrations.Migration):
    dependencies = [("core", "0137_task_groups_orthogonal")]

    operations = [
        migrations.RunPython(migrate_reminder_values, reverse_reminder_values),
        migrations.AlterField(
            model_name="taskpreference",
            name="default_reminder_minutes",
            field=models.PositiveSmallIntegerField(
                choices=[
                    (900, "On due date at 09:00"),
                    (360, "On due date at 18:00"),
                    (2340, "One day before at 09:00"),
                    (3780, "Two days before at 09:00"),
                    (5220, "Three days before at 09:00"),
                ],
                default=900,
                verbose_name="default reminder minutes",
            ),
        ),
        migrations.AlterField(
            model_name="taskreminderpreference",
            name="reminder_minutes",
            field=models.PositiveSmallIntegerField(
                blank=True,
                choices=[
                    (900, "On due date at 09:00"),
                    (360, "On due date at 18:00"),
                    (2340, "One day before at 09:00"),
                    (3780, "Two days before at 09:00"),
                    (5220, "Three days before at 09:00"),
                ],
                help_text="Empty follows the user's default task reminder.",
                null=True,
                verbose_name="reminder minutes",
            ),
        ),
    ]
