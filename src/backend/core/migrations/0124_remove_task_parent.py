from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("core", "0123_task_list_access")]

    operations = [
        migrations.RemoveField(
            model_name="task",
            name="parent",
        ),
    ]
