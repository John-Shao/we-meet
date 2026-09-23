from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0191_collaboration_teams_and_notices")]
    operations = [
        migrations.AddField(
            model_name="meetingoriginalsegment",
            name="word_alignment",
            field=models.JSONField(null=True, blank=True),
        ),
        migrations.AddField(
            model_name="meetingoriginalsegment",
            name="alignment_revision",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="meetingoriginalsegment",
            name="alignment_status",
            field=models.CharField(max_length=16, default="missing"),
        ),
    ]
