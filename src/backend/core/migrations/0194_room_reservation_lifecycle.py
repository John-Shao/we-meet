from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0193_record_overview_language")]
    operations = [
        migrations.AddField(
            model_name="room",
            name="reservation_cancelled_at",
            field=models.DateTimeField(null=True, blank=True),
        ),
        migrations.AddField(
            model_name="room",
            name="closure_reason",
            field=models.CharField(max_length=24, blank=True, default=""),
        ),
    ]
