# Add ``AIAgentProfile.agent_type`` — user-facing audio/video classifier
# used by the App client to route 「打电话」 to the right profile without
# string-matching on ``code``.
#
# AddField uses default="audio" (the conservative choice — a profile lacking
# vision capability shouldn't be picked for video). The data migration then
# upgrades known vision-capable seeded profiles to "video".
from django.db import migrations, models


# code → agent_type for the profiles seeded by 0025. Anything not in this
# map (custom profiles added later by ops) keeps the AddField default
# ("audio"); ops can adjust via admin.
_VIDEO_PROFILE_CODES = ("qwen", "doubao_pipeline")


def assign_agent_type(apps, schema_editor):
    AIAgentProfile = apps.get_model("core", "AIAgentProfile")
    AIAgentProfile.objects.filter(code__in=_VIDEO_PROFILE_CODES).update(
        agent_type="video"
    )


def reset_agent_type(apps, schema_editor):
    AIAgentProfile = apps.get_model("core", "AIAgentProfile")
    AIAgentProfile.objects.update(agent_type="audio")


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0035_simplify_aiprompt"),
    ]

    operations = [
        migrations.AddField(
            model_name="aiagentprofile",
            name="agent_type",
            field=models.CharField(
                choices=[("audio", "Audio-only interactive agent"),
                         ("video", "Video-capable interactive agent")],
                default="audio",
                max_length=8,
                verbose_name="agent type",
            ),
        ),
        migrations.RunPython(assign_agent_type, reverse_code=reset_agent_type),
    ]
