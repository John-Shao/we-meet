# Seed the full Qwen3-Omni-Realtime voice catalog onto the
# ``aliyun/qwen3-omni-flash-realtime`` model. Idempotent: re-running refreshes
# each voice's label / sort order and adds any missing ones (get/update by the
# ``(model, value)`` unique key). Source: 阿里云 qwen3-omni-flash-realtime 官方
# 音色列表 (voice 参数). Only the existing ``value`` / ``label`` / ``sort_order``
# / ``is_active`` fields are used — no schema change. ``label`` = "<voice>（中文名）".
#
# The placeholder voices ``Cherry`` / ``Ethan`` seeded by 0025 share their
# value with rows below, so they are updated in place to the official names.
from django.db import migrations


OMNI_MODEL_CODE = "aliyun/qwen3-omni-flash-realtime"

# These rows pre-exist (created by 0025); reverse restores their original state.
PLACEHOLDERS = {
    "Cherry": ("Cherry（女声）", 10),
    "Ethan": ("Ethan（男声）", 20),
}

# (voice param, display label) in catalog order. sort_order = index * 10.
VOICES = [
    ("Cherry", "Cherry（芊悦）"),
    ("Serena", "Serena（苏瑶）"),
    ("Ethan", "Ethan（晨煦）"),
    ("Chelsie", "Chelsie（千雪）"),
    ("Momo", "Momo（茉兔）"),
    ("Vivian", "Vivian（十三）"),
    ("Moon", "Moon（月白）"),
    ("Maia", "Maia（四月）"),
    ("Kai", "Kai（凯）"),
    ("Nofish", "Nofish（不吃鱼）"),
    ("Bella", "Bella（萌宝）"),
    ("Jennifer", "Jennifer（詹妮弗）"),
    ("Ryan", "Ryan（甜茶）"),
    ("Katerina", "Katerina（卡捷琳娜）"),
    ("Aiden", "Aiden（艾登）"),
    ("Eldric Sage", "Eldric Sage（沧明子）"),
    ("Mia", "Mia（乖小妹）"),
    ("Mochi", "Mochi（沙小弥）"),
    ("Bellona", "Bellona（燕铮莺）"),
    ("Vincent", "Vincent（田叔）"),
    ("Bunny", "Bunny（萌小姬）"),
    ("Neil", "Neil（阿闻）"),
    ("Elias", "Elias（墨讲师）"),
    ("Arthur", "Arthur（徐大爷）"),
    ("Nini", "Nini（邻家妹妹）"),
    ("Ebona", "Ebona（诡婆婆）"),
    ("Seren", "Seren（小婉）"),
    ("Pip", "Pip（顽屁小孩）"),
    ("Stella", "Stella（少女阿月）"),
    ("Bodega", "Bodega（博德加）"),
    ("Sonrisa", "Sonrisa（索尼莎）"),
    ("Alek", "Alek（阿列克）"),
    ("Dolce", "Dolce（多尔切）"),
    ("Sohee", "Sohee（素熙）"),
    ("Ono Anna", "Ono Anna（小野杏）"),
    ("Lenn", "Lenn（莱恩）"),
    ("Emilien", "Emilien（埃米尔安）"),
    ("Andre", "Andre（安德雷）"),
    ("Radio Gol", "Radio Gol（拉迪奥·戈尔）"),
    ("Jada", "Jada（上海-阿珍）"),
    ("Dylan", "Dylan（北京-晓东）"),
    ("Li", "Li（南京-老李）"),
    ("Marcus", "Marcus（陕西-秦川）"),
    ("Roy", "Roy（闽南-阿杰）"),
    ("Peter", "Peter（天津-李彼得）"),
    ("Sunny", "Sunny（四川-晴儿）"),
    ("Eric", "Eric（四川-程川）"),
    ("Rocky", "Rocky（粤语-阿强）"),
    ("Kiki", "Kiki（粤语-阿清）"),
]


def seed_voices(apps, schema_editor):
    AIModel = apps.get_model("core", "AIModel")
    AIVoice = apps.get_model("core", "AIVoice")

    try:
        model = AIModel.objects.get(code=OMNI_MODEL_CODE)
    except AIModel.DoesNotExist:
        # Catalog not seeded yet (e.g. fresh DB run before 0025 data); skip.
        return

    for index, (value, label) in enumerate(VOICES, start=1):
        AIVoice.objects.update_or_create(
            model=model,
            value=value,
            defaults={
                "label": label,
                "sort_order": index * 10,
                "is_active": True,
            },
        )


def unseed_voices(apps, schema_editor):
    AIModel = apps.get_model("core", "AIModel")
    AIVoice = apps.get_model("core", "AIVoice")

    try:
        model = AIModel.objects.get(code=OMNI_MODEL_CODE)
    except AIModel.DoesNotExist:
        return

    # Remove the voices this migration added, but keep the placeholder rows
    # 0025 owns and restore their original label / sort order.
    AIVoice.objects.filter(
        model=model, value__in=[value for value, _ in VOICES]
    ).exclude(value__in=PLACEHOLDERS).delete()
    for value, (label, sort_order) in PLACEHOLDERS.items():
        AIVoice.objects.filter(model=model, value=value).update(
            label=label, sort_order=sort_order
        )


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0037_seed_doubao_tts2_voices"),
    ]

    operations = [
        migrations.RunPython(seed_voices, unseed_voices),
    ]
