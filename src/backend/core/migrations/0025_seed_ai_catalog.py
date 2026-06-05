# Seed the AI catalog (vendors, models, prompt categories, agent profiles,
# default voices) and back-fill the temp FK fields added by 0024 from the
# existing legacy ``AIVoice.provider`` / ``AIPrompt.category`` columns.
# Migration 0026 then drops the legacy columns and renames the temp FKs.
from django.db import migrations


VENDORS = [
    {"code": "volcengine", "display_name": "火山引擎", "sort_order": 10},
    {"code": "aliyun", "display_name": "阿里云", "sort_order": 20},
]


MODELS = [
    # Doubao component pipeline (volcengine)
    {
        "vendor": "volcengine",
        "capability": "stt",
        "code": "volcengine/seed-asr",
        "display_name": "Seed-ASR",
        "api_key_env": "DOUBAO_ASR_ACCESS_TOKEN",
        "sort_order": 10,
    },
    {
        "vendor": "volcengine",
        "capability": "vlm",
        "code": "volcengine/doubao-vision-pro",
        "display_name": "Doubao Vision Pro",
        "api_key_env": "ARK_API_KEY",
        "sort_order": 20,
    },
    {
        "vendor": "volcengine",
        "capability": "llm",
        "code": "volcengine/doubao-pro",
        "display_name": "Doubao Pro",
        "api_key_env": "ARK_API_KEY",
        "sort_order": 30,
    },
    {
        "vendor": "volcengine",
        "capability": "tts",
        "code": "volcengine/seed-tts-2.0",
        "display_name": "Seed-TTS 2.0",
        "api_key_env": "DOUBAO_TTS_ACCESS_TOKEN",
        "sort_order": 40,
    },
    # Omni
    {
        "vendor": "volcengine",
        "capability": "omni",
        "code": "volcengine/doubao-s2s:1.2.1.1",
        "display_name": "Doubao S2S Omni",
        "endpoint": "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
        "api_key_env": "DOUBAO_S2S_ACCESS_KEY",
        "extra_config": {"model_version": "1.2.1.1"},
        "sort_order": 50,
    },
    {
        "vendor": "aliyun",
        "capability": "omni",
        "code": "aliyun/qwen3-omni-flash-realtime",
        "display_name": "Qwen-Omni-Realtime",
        "endpoint": "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
        "api_key_env": "DASHSCOPE_API_KEY",
        "sort_order": 10,
    },
]


PROMPT_CATEGORIES = [
    {"code": "general", "label": "通用", "sort_order": 10},
    {"code": "meeting", "label": "会议", "sort_order": 20},
    {"code": "tutor", "label": "辅导", "sort_order": 30},
    {"code": "support", "label": "客服", "sort_order": 40},
]


AGENT_PROFILES = [
    {
        "code": "qwen",
        "display_name": "Qwen-Omni-Realtime",
        "architecture": "omni",
        "omni_model": "aliyun/qwen3-omni-flash-realtime",
        "sort_order": 10,
    },
    {
        "code": "doubao_s2s",
        "display_name": "Doubao S2S Omni",
        "architecture": "omni",
        "omni_model": "volcengine/doubao-s2s:1.2.1.1",
        "sort_order": 20,
    },
    {
        "code": "doubao_pipeline",
        "display_name": "Doubao Pipeline",
        "architecture": "pipeline",
        "stt_model": "volcengine/seed-asr",
        "vlm_model": "volcengine/doubao-vision-pro",
        "llm_model": "volcengine/doubao-pro",
        "tts_model": "volcengine/seed-tts-2.0",
        "sort_order": 30,
    },
]
# NOTE: ``agent_type`` is set by migration 0036 (the field doesn't exist in
# the historical schema at 0025). For new profiles added later, set it
# directly in admin or in a future migration.


# Voices to seed, keyed by the TTS / Omni model code they belong to.
DEFAULT_VOICES = {
    "aliyun/qwen3-omni-flash-realtime": [
        ("Cherry", "Cherry（女声）", 10),
        ("Ethan", "Ethan（男声）", 20),
    ],
    "volcengine/doubao-s2s:1.2.1.1": [
        ("zh_female_vv_jupiter_bigtts", "Jupiter 女声", 10),
        ("zh_male_mars_jupiter_bigtts", "Jupiter 男声", 20),
    ],
    "volcengine/seed-tts-2.0": [
        ("zh_female_vv_uranus_bigtts", "Uranus 女声", 10),
        ("zh_male_mars_jupiter_bigtts", "Jupiter 男声", 20),
    ],
}


# Legacy ``AIVoice.provider`` → new model code, used to back-fill the temp
# FK on existing rows.
LEGACY_PROVIDER_TO_MODEL = {
    "qwen": "aliyun/qwen3-omni-flash-realtime",
    "doubao_s2s": "volcengine/doubao-s2s:1.2.1.1",
    "doubao": "volcengine/seed-tts-2.0",
}


def _legacy_provider_for_model(model_code):
    for provider, code in LEGACY_PROVIDER_TO_MODEL.items():
        if code == model_code:
            return provider
    return "doubao"


def seed_catalog(apps, schema_editor):
    AIVendor = apps.get_model("core", "AIVendor")
    AIModel = apps.get_model("core", "AIModel")
    AIPromptCategory = apps.get_model("core", "AIPromptCategory")
    AIAgentProfile = apps.get_model("core", "AIAgentProfile")
    AIVoice = apps.get_model("core", "AIVoice")
    AIPrompt = apps.get_model("core", "AIPrompt")

    # 1. Vendors
    vendors = {}
    for v in VENDORS:
        obj, _ = AIVendor.objects.get_or_create(
            code=v["code"],
            defaults={
                "display_name": v["display_name"],
                "sort_order": v["sort_order"],
            },
        )
        vendors[v["code"]] = obj

    # 2. Models
    models_by_code = {}
    for m in MODELS:
        obj, _ = AIModel.objects.get_or_create(
            vendor=vendors[m["vendor"]],
            capability=m["capability"],
            code=m["code"],
            defaults={
                "display_name": m["display_name"],
                "endpoint": m.get("endpoint", ""),
                "api_key_env": m.get("api_key_env", ""),
                "extra_config": m.get("extra_config", {}),
                "sort_order": m.get("sort_order", 0),
            },
        )
        models_by_code[m["code"]] = obj

    # 3. Prompt categories
    categories = {}
    for c in PROMPT_CATEGORIES:
        obj, _ = AIPromptCategory.objects.get_or_create(
            code=c["code"],
            defaults={"label": c["label"], "sort_order": c["sort_order"]},
        )
        categories[c["code"]] = obj

    # 4. Back-fill existing AIVoice rows (legacy provider → model FK)
    for voice in AIVoice.objects.filter(_model_fk__isnull=True):
        legacy_provider = getattr(voice, "provider", None)
        model_code = LEGACY_PROVIDER_TO_MODEL.get(legacy_provider)
        if model_code and model_code in models_by_code:
            voice._model_fk = models_by_code[model_code]
            voice.save(update_fields=["_model_fk"])

    # 5. Seed default voices (idempotent against legacy unique=(provider,value))
    for model_code, voice_specs in DEFAULT_VOICES.items():
        model_obj = models_by_code[model_code]
        legacy_provider = _legacy_provider_for_model(model_code)
        for value, label, sort_order in voice_specs:
            obj, _ = AIVoice.objects.get_or_create(
                provider=legacy_provider,
                value=value,
                defaults={
                    "label": label,
                    "sort_order": sort_order,
                    "is_active": True,
                },
            )
            if not obj._model_fk_id:
                obj._model_fk = model_obj
                obj.save(update_fields=["_model_fk"])

    # 6. Back-fill existing AIPrompt rows (legacy category string → category FK)
    for prompt in AIPrompt.objects.filter(_category_fk__isnull=True):
        legacy_category = getattr(prompt, "category", None) or "general"
        cat = categories.get(legacy_category) or categories.get("general")
        if cat:
            prompt._category_fk = cat
            prompt.save(update_fields=["_category_fk"])

    # 7. Agent profiles + default voice / prompt
    for p in AGENT_PROFILES:
        defaults = {
            "display_name": p["display_name"],
            "architecture": p["architecture"],
            "sort_order": p["sort_order"],
            "stt_model": models_by_code.get(p.get("stt_model", "")),
            "vlm_model": models_by_code.get(p.get("vlm_model", "")),
            "llm_model": models_by_code.get(p.get("llm_model", "")),
            "tts_model": models_by_code.get(p.get("tts_model", "")),
            "omni_model": models_by_code.get(p.get("omni_model", "")),
        }
        profile, _ = AIAgentProfile.objects.get_or_create(
            code=p["code"], defaults=defaults
        )

        voice_model_code = p.get("omni_model") or p.get("tts_model")
        if voice_model_code:
            voice = (
                AIVoice.objects.filter(
                    _model_fk__code=voice_model_code, is_active=True
                )
                .order_by("sort_order", "label")
                .first()
            )
            if voice and not profile.default_voice_id:
                profile.default_voice = voice
                profile.save(update_fields=["default_voice"])


def unseed_catalog(apps, schema_editor):
    """Clear temp FKs so 0024 can roll back; seeded rows are left intact."""
    AIVoice = apps.get_model("core", "AIVoice")
    AIPrompt = apps.get_model("core", "AIPrompt")
    AIVoice.objects.update(_model_fk=None)
    AIPrompt.objects.update(_category_fk=None)


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0024_ai_catalog_schema"),
    ]

    operations = [
        migrations.RunPython(seed_catalog, unseed_catalog),
    ]
