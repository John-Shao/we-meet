import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """Stop cascading task deletion into the subtask tree.

    Deleting a task now clears the parent link of its direct subtasks instead of
    destroying them, so the database agrees with the API contract even when a
    row is removed by a path that does not go through the task viewset (task
    list cleanup, admin, organization cascade).
    """

    dependencies = [("core", "0141_imconversation_avatar_key")]

    operations = [
        migrations.AlterField(
            model_name="task",
            name="parent",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="subtasks",
                to="core.task",
                verbose_name="parent task",
            ),
        ),
    ]
