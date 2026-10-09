"""Seed the independently managed LiveTranslate voice catalog."""

from django.db import migrations

VOICES = [
    ["Tina", "甜甜"],
    ["Cindy", "林欣宜"],
    ["Liora Mira", "清欢"],
    ["Sunnybobi", "知芝"],
    ["Raymond", "林川野"],
    ["Ethan", "晨煦"],
    ["Theo Calm", "予安"],
    ["Serena", "苏瑶"],
    ["Harvey", "厚"],
    ["Maia", "四月"],
    ["Evan", "江晨"],
    ["Qiao", "小乔妹"],
    ["Momo", "茉兔"],
    ["Wil", "伟伦"],
    ["Angel", "台普 - 安琪"],
    ["Li Cassian", "东厂 - 李公公"],
    ["Mia", "温柔生活博主 - 舒然"],
    ["Joyner", "喜剧担当 - 阿逗"],
    ["Gold", "金爷"],
    ["Katerina", "卡捷琳娜"],
    ["Ryan", "甜茶"],
    ["Jennifer", "詹妮弗"],
    ["Aiden", "艾登"],
    ["Mione", "敏儿"],
    ["Sohee", "素熙"],
    ["Lenn", "莱恩"],
    ["Ono Anna", "小野杏"],
    ["Sonrisa", "索尼莎"],
    ["Bodega", "博德加"],
    ["Emilien", "埃米尔安"],
    ["Andre", "安德雷"],
    ["Radio Gol", "拉迪奥·戈尔"],
    ["Alek", "阿列克"],
    ["Rizky", "阿力"],
    ["Roya", "萝雅"],
    ["Arda", "阿尔达"],
    ["Hana", "阿幸"],
    ["Dolce", "多尔切"],
    ["Jakub", "雅克"],
    ["Griet", "海娜"],
    ["Eliška", "艾莉卡"],
    ["Marina", "玛丽娜"],
    ["Siiri", "西芮"],
    ["Ingrid", "林恩"],
    ["Sigga", "海娜"],
    ["Bea", "雅娜"],
    ["Chloe", "思怡"],
]


def seed(apps, schema_editor):
    db = schema_editor.connection.alias
    Vendor = apps.get_model("core", "AIVendor")
    Model = apps.get_model("core", "AIModel")
    Voice = apps.get_model("core", "AIVoice")
    vendor, _ = Vendor.objects.using(db).get_or_create(
        code="aliyun", defaults={"display_name": "阿里云"}
    )
    model, _ = Model.objects.using(db).get_or_create(
        vendor=vendor,
        capability="omni",
        code="aliyun/qwen3.8-livetranslate-flash-realtime",
        defaults={
            "display_name": "Qwen3.8-LiveTranslate-Flash-Realtime",
            "api_key_env": "DASHSCOPE_API_KEY",
            "extra_config": {"default_voice": "Tina"},
        },
    )
    for index, (value, label) in enumerate(VOICES):
        Voice.objects.using(db).get_or_create(
            model=model,
            value=value,
            defaults={"label": f"{value}（{label}）", "sort_order": (index + 1) * 10},
        )


class Migration(migrations.Migration):
    dependencies = [("core", "0197_directaiallocation")]
    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
