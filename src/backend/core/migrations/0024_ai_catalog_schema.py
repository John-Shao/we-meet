# AI catalog schema: vendor/model/prompt-category/agent-profile/user-preference
# tables, plus temp nullable FK fields on AIVoice and AIPrompt that 0025
# back-fills and 0026 renames to the final names declared in models.py.
import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0023_aivoice_aiprompt"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AIVendor",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                ("code", models.CharField(max_length=64, unique=True, verbose_name="code")),
                ("display_name", models.CharField(max_length=128, verbose_name="display name")),
                ("sort_order", models.PositiveSmallIntegerField(default=0, verbose_name="sort order")),
                ("is_active", models.BooleanField(default=True, verbose_name="active")),
            ],
            options={
                "verbose_name": "AI vendor",
                "verbose_name_plural": "AI vendors",
                "ordering": ("sort_order", "code"),
            },
        ),
        migrations.CreateModel(
            name="AIModel",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                (
                    "capability",
                    models.CharField(
                        choices=[
                            ("stt", "Speech-to-text"),
                            ("llm", "Language model"),
                            ("tts", "Text-to-speech"),
                            ("vlm", "Vision-language model"),
                            ("omni", "End-to-end omni-modal"),
                        ],
                        max_length=16,
                        verbose_name="capability",
                    ),
                ),
                (
                    "code",
                    models.CharField(
                        help_text=(
                            "Model identifier in livekit-style ``vendor/model[:variant]`` "
                            "form (e.g. ``volcengine/seed-asr``)."
                        ),
                        max_length=128,
                        verbose_name="model code",
                    ),
                ),
                ("display_name", models.CharField(max_length=128, verbose_name="display name")),
                (
                    "endpoint",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "WebSocket / HTTP endpoint URL. Optional — many SDK-based "
                            "plugins infer this from the vendor."
                        ),
                        max_length=512,
                        verbose_name="endpoint",
                    ),
                ),
                (
                    "api_key_env",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "Name of the environment variable holding the API key for "
                            "this model. The DB only stores the name; the secret stays "
                            "in the agent process env."
                        ),
                        max_length=128,
                        verbose_name="API key env var",
                    ),
                ),
                (
                    "extra_config",
                    models.JSONField(
                        blank=True,
                        default=dict,
                        help_text=(
                            "Model-specific parameters (sample_rate, model_version, "
                            "speaking_style, ...)."
                        ),
                        verbose_name="extra config",
                    ),
                ),
                ("sort_order", models.PositiveSmallIntegerField(default=0, verbose_name="sort order")),
                ("is_active", models.BooleanField(default=True, verbose_name="active")),
                (
                    "vendor",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="models",
                        to="core.aivendor",
                        verbose_name="vendor",
                    ),
                ),
            ],
            options={
                "verbose_name": "AI model",
                "verbose_name_plural": "AI models",
                "ordering": ("vendor", "capability", "sort_order", "code"),
                "unique_together": {("vendor", "capability", "code")},
            },
        ),
        migrations.CreateModel(
            name="AIPromptCategory",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                ("code", models.CharField(max_length=32, unique=True, verbose_name="code")),
                ("label", models.CharField(max_length=64, verbose_name="label")),
                ("sort_order", models.PositiveSmallIntegerField(default=0, verbose_name="sort order")),
                ("is_active", models.BooleanField(default=True, verbose_name="active")),
            ],
            options={
                "verbose_name": "AI prompt category",
                "verbose_name_plural": "AI prompt categories",
                "ordering": ("sort_order", "code"),
            },
        ),
        # Temporary FK fields on AIVoice / AIPrompt; 0026 renames them to the
        # final names declared in models.py after 0025 back-fills the data.
        migrations.AddField(
            model_name="aivoice",
            name="_model_fk",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="voices_via_fk",
                to="core.aimodel",
                verbose_name="model",
            ),
        ),
        migrations.AddField(
            model_name="aiprompt",
            name="_category_fk",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="prompts_via_fk",
                to="core.aipromptcategory",
                verbose_name="category",
            ),
        ),
        migrations.CreateModel(
            name="AIAgentProfile",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                ("code", models.CharField(max_length=64, unique=True, verbose_name="code")),
                ("display_name", models.CharField(max_length=128, verbose_name="display name")),
                (
                    "architecture",
                    models.CharField(
                        choices=[
                            ("pipeline", "STT/LLM/TTS pipeline"),
                            ("omni", "End-to-end omni-modal"),
                        ],
                        max_length=16,
                        verbose_name="architecture",
                    ),
                ),
                ("sort_order", models.PositiveSmallIntegerField(default=0, verbose_name="sort order")),
                ("is_active", models.BooleanField(default=True, verbose_name="active")),
                (
                    "stt_model",
                    models.ForeignKey(
                        blank=True,
                        limit_choices_to={"capability": "stt"},
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="profile_as_stt",
                        to="core.aimodel",
                        verbose_name="STT model",
                    ),
                ),
                (
                    "tts_model",
                    models.ForeignKey(
                        blank=True,
                        limit_choices_to={"capability": "tts"},
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="profile_as_tts",
                        to="core.aimodel",
                        verbose_name="TTS model",
                    ),
                ),
                (
                    "vlm_model",
                    models.ForeignKey(
                        blank=True,
                        limit_choices_to={"capability": "vlm"},
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="profile_as_vlm",
                        to="core.aimodel",
                        verbose_name="VLM model",
                    ),
                ),
                (
                    "llm_model",
                    models.ForeignKey(
                        blank=True,
                        limit_choices_to={"capability": "llm"},
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="profile_as_llm",
                        to="core.aimodel",
                        verbose_name="LLM model",
                    ),
                ),
                (
                    "omni_model",
                    models.ForeignKey(
                        blank=True,
                        limit_choices_to={"capability": "omni"},
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="profile_as_omni",
                        to="core.aimodel",
                        verbose_name="omni model",
                    ),
                ),
                (
                    "default_voice",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="core.aivoice",
                        verbose_name="default voice",
                    ),
                ),
                (
                    "default_prompt",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="core.aiprompt",
                        verbose_name="default prompt",
                    ),
                ),
            ],
            options={
                "verbose_name": "AI agent profile",
                "verbose_name_plural": "AI agent profiles",
                "ordering": ("sort_order", "code"),
            },
        ),
        migrations.CreateModel(
            name="UserAIPreference",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ai_preference",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="user",
                    ),
                ),
                (
                    "profile",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="core.aiagentprofile",
                    ),
                ),
                (
                    "voice",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="core.aivoice",
                    ),
                ),
                (
                    "prompt",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="core.aiprompt",
                    ),
                ),
            ],
            options={
                "verbose_name": "user AI preference",
                "verbose_name_plural": "user AI preferences",
            },
        ),
    ]
