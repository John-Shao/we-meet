# Sprint 2.1: store best-effort multi-language translations alongside the
# original transcript, keyed by ISO code. Written by the transcriber agent
# right after FINAL_TRANSCRIPT capture; absence of a key means translation
# was not requested or failed.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0028_rename_transcript_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="transcript",
            name="translations",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    "Best-effort translations into other languages, keyed by ISO "
                    "code (e.g. ``{'en-us': '...', 'zh-cn': '...'}``). Written by "
                    "the transcriber agent immediately after the FINAL transcript "
                    "is captured; absence of a key means translation was not "
                    "requested or failed."
                ),
                verbose_name="translations",
            ),
        ),
    ]
