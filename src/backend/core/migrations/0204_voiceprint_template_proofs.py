from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0203_voiceprint_enrollment")]

    operations = [
        migrations.AddField(
            model_name="voiceprintprofile",
            name="template_checked_at",
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="voiceprinttemplate",
            name="revision",
            field=models.PositiveBigIntegerField(default=1),
        ),
        migrations.AddField(
            model_name="voiceprinttemplate",
            name="policy_version",
            field=models.CharField(blank=True, default="", max_length=96),
        ),
        migrations.AddField(
            model_name="voiceprinttemplate",
            name="support_digest",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
    ]
