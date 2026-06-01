# Generated for RESOURCE_DEFAULT_ACCESS_LEVEL default change ("public" -> "trusted").

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0031_transcriptchunk"),
    ]

    operations = [
        migrations.AlterField(
            model_name="room",
            name="access_level",
            field=models.CharField(
                choices=[
                    ("public", "Public Access"),
                    ("trusted", "Trusted Access"),
                    ("restricted", "Restricted Access"),
                ],
                default="trusted",
                max_length=50,
            ),
        ),
    ]
