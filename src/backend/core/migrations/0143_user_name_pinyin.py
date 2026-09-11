"""通讯录 A–Z 索引:User 的拼音排序键与首字母两列。

``full_name_pinyin`` / ``full_name_initial`` 平时由 ``User.save()`` 维护;这份迁移
负责把已有用户补上(线上老数据在加列之后都是空串,不补的话整册人都会掉进
``#`` 桶、拼音排序也退化成编码序)。

排序/首字母的算法在这里是**冻结副本**:迁移不该 import 会变的 app 代码(同
``0070_seed_employee_types`` 的理由)。权威实现仍是 ``core/services/pinyin.py``,
两边语义要保持一致 —— 不一致的后果是「迁移补出来的顺序」和「新用户保存后的顺序」
不一样,肉眼看不出来,但索引会错位。
"""

import unicodedata

import django.db.models.deletion
from django.db import migrations, models

from pypinyin import Style, lazy_pinyin

OTHER_INITIAL = "#"

#: 与 core/services/pinyin.py 逐字一致(见文件头「冻结副本」的说明)。
#: 有测试(core/tests/services/test_pinyin.py::test_migration_copy_matches_service)
#: 盯着这两份不许漂。
_NON_DECOMPOSABLE = str.maketrans(
    {
        "ø": "o",
        "ł": "l",
        "đ": "d",
        "ð": "d",
        "þ": "t",
        "æ": "ae",
        "œ": "oe",
        "ß": "ss",
        "ı": "i",
    }
)


def _fold_latin(text):
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.translate(_NON_DECOMPOSABLE)


def _sort_key(name):
    cleaned = (name or "").strip()
    if not cleaned:
        return ""
    syllables = lazy_pinyin(cleaned, style=Style.NORMAL, errors="default")
    joined = "".join("".join(syllables).split()).lower()
    return _fold_latin(joined)[:255]


def _initial(name):
    key = _sort_key(name)
    if not key:
        return OTHER_INITIAL
    first = key[0]
    return first.upper() if "a" <= first <= "z" else OTHER_INITIAL


def backfill_name_pinyin(apps, schema_editor):
    """按批回填。用户量级是「组织人数」,一次全表读进内存也没事,但分批更稳。"""
    User = apps.get_model("core", "User")
    batch = []
    for user in User.objects.only("id", "full_name").iterator(chunk_size=500):
        user.full_name_pinyin = _sort_key(user.full_name)
        user.full_name_initial = _initial(user.full_name)
        batch.append(user)
        if len(batch) >= 500:
            User.objects.bulk_update(
                batch, ["full_name_pinyin", "full_name_initial"]
            )
            batch = []
    if batch:
        User.objects.bulk_update(batch, ["full_name_pinyin", "full_name_initial"])


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0142_alter_task_parent"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="full_name_pinyin",
            field=models.CharField(
                blank=True,
                db_index=True,
                default="",
                help_text=(
                    "Lowercased pinyin of `full name`, derived on save. Directory "
                    "lists order by it so Chinese names sort in pinyin order, not "
                    "code-point order."
                ),
                max_length=255,
                verbose_name="full name pinyin",
            ),
        ),
        migrations.AddField(
            model_name="user",
            name="full_name_initial",
            field=models.CharField(
                blank=True,
                db_index=True,
                default="#",
                help_text=(
                    "A–Z initial of `full name` (derived on save); '#' for names "
                    "whose initial cannot be derived (digits, symbols, empty). "
                    "Buckets the directory's alphabet index."
                ),
                max_length=1,
                verbose_name="full name initial",
            ),
        ),
        migrations.RunPython(
            backfill_name_pinyin,
            # 反向只是删列,数据没什么可回滚的;给个 no-op 免得切回旧版本时报错。
            migrations.RunPython.noop,
        ),
    ]
