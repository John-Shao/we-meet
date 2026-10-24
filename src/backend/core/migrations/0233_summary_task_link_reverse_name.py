from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0232_builtin_work_grant_permissions")]

    operations = [
        migrations.AlterField(
            model_name="meetingsummarytasklink",
            name="task",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=models.SET_NULL,
                related_name="meeting_summary_link",
                to="core.task",
            ),
        ),
    ]
