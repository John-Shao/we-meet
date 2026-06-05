# Decouple AIAgentProfile from AIPrompt: drop the profile-level
# ``default_prompt`` FK. Prompt resolution now relies on the explicit
# request value or the user's stored preference only — model and prompt
# are independent catalogs.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0033_room_scheduled_at"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="aiagentprofile",
            name="default_prompt",
        ),
    ]
