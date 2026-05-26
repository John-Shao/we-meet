# Drop legacy ``AIVoice.provider`` and ``AIPrompt.category`` (CharField),
# rename the temp FKs added by 0024 to their final names, and tighten them
# to NOT NULL with the limit_choices_to / related_name declared in models.py.
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0025_seed_ai_catalog"),
    ]

    operations = [
        # ---- AIVoice: drop legacy `provider`, rename `_model_fk` → `model` ----
        migrations.AlterUniqueTogether(
            name="aivoice",
            unique_together=set(),
        ),
        migrations.RemoveField(
            model_name="aivoice",
            name="provider",
        ),
        migrations.RenameField(
            model_name="aivoice",
            old_name="_model_fk",
            new_name="model",
        ),
        migrations.AlterField(
            model_name="aivoice",
            name="model",
            field=models.ForeignKey(
                limit_choices_to={"capability__in": ("tts", "omni")},
                on_delete=django.db.models.deletion.CASCADE,
                related_name="voices",
                to="core.aimodel",
                verbose_name="model",
            ),
        ),
        migrations.AlterUniqueTogether(
            name="aivoice",
            unique_together={("model", "value")},
        ),
        migrations.AlterModelOptions(
            name="aivoice",
            options={
                "ordering": ("model", "sort_order", "label"),
                "verbose_name": "AI voice",
                "verbose_name_plural": "AI voices",
            },
        ),
        # ---- AIPrompt: drop legacy `category` CharField, rename FK → `category` ----
        migrations.AlterUniqueTogether(
            name="aiprompt",
            unique_together=set(),
        ),
        migrations.RemoveField(
            model_name="aiprompt",
            name="category",
        ),
        migrations.RenameField(
            model_name="aiprompt",
            old_name="_category_fk",
            new_name="category",
        ),
        migrations.AlterField(
            model_name="aiprompt",
            name="category",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="prompts",
                to="core.aipromptcategory",
                verbose_name="category",
            ),
        ),
        migrations.AlterUniqueTogether(
            name="aiprompt",
            unique_together={("category", "label")},
        ),
        migrations.AlterModelOptions(
            name="aiprompt",
            options={
                "ordering": ("category", "sort_order", "label"),
                "verbose_name": "AI prompt",
                "verbose_name_plural": "AI prompts",
            },
        ),
    ]
