from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0184_personal_hotwords")]
    operations = [
        migrations.AddField(
            model_name="meetingrecord",
            name="deleted_at",
            field=models.DateTimeField(null=True, blank=True, db_index=True),
        ),
        migrations.AddField(
            model_name="meetingrecord",
            name="lifecycle_revision",
            field=models.PositiveIntegerField(default=0),
        ),
    ]
