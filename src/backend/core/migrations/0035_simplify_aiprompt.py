# Flatten the AI prompt catalog: drop the AIPromptCategory dimension and
# the AIPrompt.category FK. Prompts now live in a single global list keyed
# by ``label`` (unique).
#
# AlterModelOptions wipes the old (category, sort_order, label) ordering
# + (category, label) unique_together that referenced the FK; RemoveField
# then drops the column; DeleteModel removes the orphaned category table.
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0034_drop_aiagentprofile_default_prompt"),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name="aiprompt",
            unique_together=set(),
        ),
        migrations.AlterModelOptions(
            name="aiprompt",
            options={
                "ordering": ("sort_order", "label"),
                "verbose_name": "AI prompt",
                "verbose_name_plural": "AI prompts",
            },
        ),
        migrations.RemoveField(
            model_name="aiprompt",
            name="category",
        ),
        migrations.AlterField(
            model_name="aiprompt",
            name="label",
            field=models.CharField(max_length=128, unique=True, verbose_name="label"),
        ),
        migrations.DeleteModel(
            name="AIPromptCategory",
        ),
    ]
