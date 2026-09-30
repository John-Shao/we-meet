"""Upgrade Qwen profiles and voice choices without rewriting historical models."""

from django.db import migrations

OLD_MODEL_CODE = "aliyun/qwen3-omni-flash-realtime"
MODEL_CODE = "aliyun/qwen3.8-omni-flash-realtime"

# Official 3.8 voice identifiers; Cherry/Ethan and other 3.0-only voices are absent.
# https://help.aliyun.com/zh/model-studio/omni-voice-list#qwen38-voices
VOICES = (
    ("Tina", "甜甜"),
    ("Cindy", "林欣宜"),
    ("Liora Mira", "清欢"),
    ("Raymond", "林川野"),
    ("Zane", "泽恩"),
    ("Katerina", "卡捷琳娜"),
    ("Ryan", "甜茶"),
    ("Mia", "舒然"),
    ("Cici", "绵绵"),
    ("Theo Calm", "予安"),
    ("Serena", "苏瑶"),
    ("Maia", "四月"),
    ("Evan", "江晨"),
    ("Qiao", "小乔妹"),
    ("Momo", "茉兔"),
    ("Wil", "伟伦"),
    ("Angel", "安琪"),
    ("Li Cassian", "李公公"),
    ("Joyner", "阿逗"),
    ("Gold", "金爷"),
    ("Jennifer", "詹妮弗"),
    ("Aiden", "艾登"),
    ("Mione", "敏儿"),
    ("Sunny", "四川-晴儿"),
    ("Dylan", "北京-晓东"),
    ("Eric", "四川-程川"),
    ("Peter", "天津-李彼得"),
    ("Joseph Chen", "阿樸伯"),
    ("Marcus", "陕西-秦川"),
    ("Li", "南京-老李"),
    ("Rocky", "粤语-阿强"),
    ("Kiki", "粤语-阿清"),
    ("Sohee", "素熙"),
    ("Eliška", "艾莉卡"),
    ("Alek", "阿列克"),
    ("Arda", "阿尔达"),
    ("Dolce", "多尔切"),
    ("Lenn", "莱恩"),
    ("Ono Anna", "小野杏"),
    ("Sonrisa", "索尼莎"),
    ("Bodega", "博德加"),
    ("Andre", "安德雷"),
    ("Radio Gol", "拉迪奥·戈尔"),
    ("Rizky", "阿力"),
    ("Roya", "萝雅"),
    ("Hana", "阿幸"),
    ("Jakub", "雅克"),
    ("Griet", "海娜"),
    ("Marina", "玛丽娜"),
    ("Siiri", "西芮"),
    ("Ingrid", "林恩"),
    ("Sigga", "海娜"),
    ("Bea", "雅娜"),
    ("Chloe", "思怡"),
    ("Emilien", "埃米尔安"),
    ("longanlingxin", "龙安灵心"),
)


def upgrade_catalog(apps, schema_editor):
    """Rebind old Qwen profiles and replace unsupported defaults with Tina."""
    alias = schema_editor.connection.alias
    Model = apps.get_model("core", "AIModel")
    Voice = apps.get_model("core", "AIVoice")
    Profile = apps.get_model("core", "AIAgentProfile")
    old = Model.objects.using(alias).filter(code=OLD_MODEL_CODE).first()
    if old is None:
        return  # Respect installations that deliberately removed the Qwen catalog.

    model, _ = Model.objects.using(alias).get_or_create(
        vendor_id=old.vendor_id,
        capability="omni",
        code=MODEL_CODE,
        defaults={
            "display_name": "Qwen3.8-Omni-Flash-Realtime",
            # The worker builds the actual URL from its workspace/region env vars.
            "endpoint": "",
            "api_key_env": old.api_key_env or "DASHSCOPE_API_KEY",
            "sort_order": old.sort_order,
            "is_active": old.is_active,
        },
    )
    voices = {}
    for index, (value, label) in enumerate(VOICES, start=1):
        voice, _ = Voice.objects.using(alias).get_or_create(
            model_id=model.pk,
            value=value,
            defaults={
                "label": f"{value}（{label}）",
                "sort_order": index * 10,
                "is_active": True,
            },
        )
        if voice.is_active:
            voices[value] = voice

    for profile in (
        Profile.objects.using(alias)
        .filter(omni_model_id=old.pk)
        .select_related("default_voice")
    ):
        value = profile.default_voice.value if profile.default_voice_id else None
        profile.omni_model_id = model.pk
        profile.default_voice = voices.get(value) or voices.get("Tina")
        profile.save(using=alias, update_fields=["omni_model", "default_voice"])

    # Retain rows for history, but cached old voice IDs must fall back to the
    # upgraded profile default instead of sending a 3.0-only voice to 3.8.
    Voice.objects.using(alias).filter(model_id=old.pk).update(is_active=False)
    Model.objects.using(alias).filter(pk=old.pk).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [("core", "0194_room_reservation_lifecycle")]

    # Schema rollback keeps the upgraded catalog: previous per-profile choices
    # and active flags cannot be recovered after users edit it. A model downgrade
    # requires an explicit catalog change; retained historical rows allow this.
    operations = [migrations.RunPython(upgrade_catalog, migrations.RunPython.noop)]
