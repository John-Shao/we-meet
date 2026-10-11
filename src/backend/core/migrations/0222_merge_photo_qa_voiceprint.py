"""Join the photo QA and voiceprint migration branches."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0200_photo_qa_prompts"),
        ("core", "0221_voiceprint_sampling_control_fence"),
    ]

    operations = []
