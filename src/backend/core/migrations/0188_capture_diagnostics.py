from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0187_upload_transcript_translation")]
    operations = [
        migrations.AddField(
            model_name="capturetranscriptionjob",
            name="diagnostics",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddIndex(
            model_name="capturetranscriptionjob",
            index=models.Index(
                fields=["created_at"],
                condition=~models.Q(diagnostics=[]),
                name="capture_diag_retention",
            ),
        ),
    ]
