from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("core", "0138_task_reminder_wall_clock_options")]

    operations = [
        migrations.RunSQL(
            sql="DROP TABLE IF EXISTS meet_task_saved_view",
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
