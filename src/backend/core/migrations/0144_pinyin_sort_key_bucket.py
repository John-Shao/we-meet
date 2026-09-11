"""通讯录拼音排序:把「桶序」编进排序键,并理顺索引。

``0143`` 给两列都加了 ``db_index=True``,排序则靠一个 ``CASE`` 表达式把 ``#`` 桶
(数字/符号/空名字)压到最后。在 5000 人的名册上实测下来,这个组合是错的:

- ``ORDER BY CASE …, full_name_pinyin, full_name`` 的首列是**表达式**,于是
  ``full_name_pinyin`` 上的 btree 完全用不上,Postgres 必须把整个组织物化再排序
  (5000 人的名册、热缓存实测:``Limit → Sort (5001 rows)`` 3.6 ms);把 ``CASE``
  去掉、只按拼音键排,规划器就沿索引取前 20 行(``Limit → Index Scan`` 0.11 ms,
  32×);
- ``full_name_initial`` 的索引一次都没被用到:字母表的 ``GROUP BY`` 走
  HashAggregate,``?from_initial=#`` 也只是 pkey 扫描上的一个 Filter。它只有约 28
  个不同值,留着就是每次保存用户多维护两条索引;
- 文本列的 ``db_index=True`` 在 Postgres 上还会额外建一条 ``varchar_pattern_ops``
  索引(给 LIKE 用),而我们从不 LIKE ``full_name_pinyin``。

所以这一版:桶序改成**排序键的一部分**(键 = 桶类前缀 + 折叠拼音,字母桶 ``0``、
``#`` 桶 ``1``),显式建一条 ``(full_name_pinyin, full_name)`` 复合索引(第二列是翻页
稳定需要的次序键),并删掉那四条自动索引。

前缀必须用**数字**而不是标点:``en_US.utf8`` collation 在主比较级别忽略标点,实测
``'~1001' < 'abao'`` 为真 —— 用 ``~`` 当「排最后」的前缀会把 ``#`` 桶顶到名册最前面。
数字是真实比较级别,``'0zhangsan' < '1zhangsan'`` 恒成立。

排序算法在迁移里照旧是**冻结副本**(理由同 ``0143`` —— 迁移不该 import 会变的 app
代码)。注意 ``0143`` 里那份副本**故意保持原样**:它代表历史上的一次回填,不能跟着
新规则改;对齐测试盯的是**本文件**与 ``core/services/pinyin.py``。

两个运维注意点(都不是功能问题,但发布时会遇到):

1. 本迁移没有 ``atomic = False``,Django 把全部操作包在一个事务里,``AlterField`` 在
   ``meet_user`` 上拿到的 ACCESS EXCLUSIVE 一直持有到 commit —— 回填(``bulk_update``
   500/批)就在这个窗口里跑。「分批」只减少往返,不缩短持锁;几千行时是亚秒级,上万行
   应改成 ``atomic = False`` + 逐批 ``transaction.atomic()`` + ``AddIndexConcurrently``。
2. 桶类前缀是编进**已存**派生列的,而 migrate 是 Helm 的 pre-upgrade hook:跑完到旧
   Pod 全部退场之间,旧镜像仍会写出**没有前缀**的 ``full_name_pinyin``。那种行在新排序
   (``ORDER BY full_name_pinyin, full_name``)下数字前缀排在字母前,于是会排到名册
   第一行。迁移已标记为已应用,不会再修它们 —— ``manage.py rebuild_pinyin_keys``。
"""

import unicodedata

import django.db.models.deletion
from django.db import migrations, models

from pypinyin import Style, lazy_pinyin

OTHER_INITIAL = "#"
LETTER_KEY_PREFIX = "0"
OTHER_KEY_PREFIX = "1"

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


def _folded_key(name):
    cleaned = (name or "").strip()
    if not cleaned:
        return ""
    syllables = lazy_pinyin(cleaned, style=Style.NORMAL, errors="default")
    joined = "".join("".join(syllables).split()).lower()
    return _fold_latin(joined)


def _sort_key(name):
    folded = _folded_key(name)
    prefix = (
        LETTER_KEY_PREFIX
        if folded and "a" <= folded[0] <= "z"
        else OTHER_KEY_PREFIX
    )
    return (prefix + folded)[:255]


def _initial(name):
    folded = _folded_key(name)
    if not folded:
        return OTHER_INITIAL
    first = folded[0]
    return first.upper() if "a" <= first <= "z" else OTHER_INITIAL


def recompute_sort_keys(apps, schema_editor):
    """按新规则重算 ``full_name_pinyin``(只有 ``#`` 桶的键会变,但整表重算更简单)。

    ``full_name_initial`` 一并写:规则没变,但让这份回填与 service 的语义完全对齐,
    以后看这段代码的人不必再想「为什么只更新一列」。
    """
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
        ("core", "0143_user_name_pinyin"),
    ]

    operations = [
        # 顺序:先删四条自动索引(AlterField 去掉 db_index)→ 回填排序键 →
        # 最后建复合索引,让索引只在最终数据上构建一次。
        migrations.AlterField(
            model_name="user",
            name="full_name_pinyin",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Sort key derived from `full name` on save: a bucket-class "
                    "digit prefix ('0' for A–Z, '1' for the '#' bucket) followed "
                    "by the lowercased, ASCII-folded pinyin. Directory lists "
                    "order by it so Chinese names sort in pinyin order, not "
                    "code-point order, and the bucket whose initial cannot be "
                    "derived sorts last."
                ),
                max_length=255,
                verbose_name="full name pinyin",
            ),
        ),
        migrations.AlterField(
            model_name="user",
            name="full_name_initial",
            field=models.CharField(
                blank=True,
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
        migrations.RunPython(recompute_sort_keys, migrations.RunPython.noop),
        migrations.AddIndex(
            model_name="user",
            index=models.Index(
                fields=["full_name_pinyin", "full_name"],
                name="meet_user_pinyin_name_idx",
            ),
        ),
    ]
