from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0192_original_word_alignment")]
    operations = [
        migrations.AddField(
            model_name="meetingrecord",
            name="overview_language",
            field=models.CharField(default="auto", max_length=12),
        ),
    ]
