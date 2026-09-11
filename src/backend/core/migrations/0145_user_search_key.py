"""通讯录拼音搜索:给 ``User`` 加 ``search_key``(全拼 + 首字母缩写)并回填。

为什么是**派生列而不是查询时现算**:用户输入 ``ye`` 想找「夜来香」,这类查询的匹配
方式是子串(``LIKE '%ye%'``)。现算就意味着每一行都要跑一次 ``pypinyin`` —— 5000 人的
组织里那是一次几百毫秒的全表函数扫描,而且没法索引。存下来之后它只是一个普通的
字符串比较(实测见下)。

词袋的形状(与 ``core/services/pinyin.py`` 的 ``pinyin_search_key`` 逐字一致)::

    夜来香      → 'yelaixiang ylx'
    张三        → 'zhangsan zs'
    Yelena Smith → 'yelenasmith ys'
    1001        → '1001 1'

于是 ``q=ye``、``q=yelaixiang``、``q=ylx``、``q=夜`` 都能命中同一个人。

**为什么没有索引**:``?q=`` 是一条跨 5 个列的 OR(姓名 / 简称 / 邮箱 / 职位 / 部门名),
单列索引对 OR 帮不上忙;而 ``icontains`` 在 Postgres 上生成的是 ``UPPER(col) LIKE …``,
列上的 btree 或 trigram 索引都用不到(要用得做成 ``UPPER(col)`` 的**表达式**索引)。
另外搜索键这一支本身用的是 ``contains``(键已全小写),理论上可以被
``gin_trgm_ops`` 服务,但只对「3 个字符以上」的查询有效 —— 而人们输的偏偏是 ``ye``
这种两个字母的。

先不加索引,拿数字说话。5000 个用户 + 5000 条 primary membership 的探针库、热缓存、
各跑 20 次取平均::

    q=ye        (拼音前缀)  20 条命中  10.97 ms   ← 与老查询同一量级
    q=ylx       (首字母)     1 条命中  10.89 ms
    q=yelaixiang(全拼)       1 条命中  10.31 ms
    q=夜        (汉字,老路径) 20 条命中 10.85 ms
    q=noluck    (最坏情况)    0 条命中  10.81 ms
    对照:去掉 search_key 那一支的老查询
    q=ye                     1 条命中  10.37 ms
    q=noluck                 0 条命中  10.25 ms

也就是说**拼音搜索没有让这条查询变慢**:它加在一条本来就全表过滤的 OR 上(计划里
两种写法都是 `Nested Loop … Filter:` 扫完 5000 行),差值 0.6 ms 在噪声范围内。
为一个省不下来的开销再加一个 GIN 索引(每次保存用户都要维护)不划算 —— 组织规模上
一个数量级、或这条查询进了慢查询日志,再补表达式索引也不迟。

算法在迁移里照旧是**冻结副本**(理由同 ``0143``/``0144`` —— 迁移不该 import 会变的
app 代码);对齐测试盯的是本文件与 ``core/services/pinyin.py``。
"""

import unicodedata

from django.db import migrations, models

from pypinyin import Style, lazy_pinyin

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


def _initials(name):
    cleaned = (name or "").strip()
    if not cleaned:
        return ""
    syllables = lazy_pinyin(cleaned, style=Style.FIRST_LETTER, errors="default")
    letters = []
    for syllable in syllables:
        # 拉丁词整词原样带过('Yelena Smith' → ['Yelena Smith']),所以再按空白切一次。
        for word in syllable.split():
            if word:
                letters.append(word[0])
    return _fold_latin("".join(letters)).lower()


def _search_key(name, short_name=None):
    tokens = [
        _folded_key(name),
        _initials(name),
        _folded_key(short_name),
        _initials(short_name),
    ]
    unique = list(dict.fromkeys(token for token in tokens if token))
    return " ".join(unique)[:255]


def backfill_search_keys(apps, schema_editor):
    User = apps.get_model("core", "User")
    batch = []
    for user in User.objects.only("id", "full_name", "short_name").iterator(
        chunk_size=500
    ):
        user.search_key = _search_key(user.full_name, user.short_name)
        batch.append(user)
        if len(batch) >= 500:
            User.objects.bulk_update(batch, ["search_key"])
            batch = []
    if batch:
        User.objects.bulk_update(batch, ["search_key"])


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0144_pinyin_sort_key_bucket"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="search_key",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Search bag derived on save from `full name` and `short name`: "
                    "the lowercased, ASCII-folded pinyin plus the pinyin initials, "
                    "e.g. 'yelaixiang ylx' for 夜来香. Lets the directory match "
                    "`q=ye` or `q=ylx` as well as the Chinese characters themselves."
                ),
                max_length=255,
                verbose_name="search key",
            ),
        ),
        # 表不大(用户量级)且回填本来就要全表扫一遍,所以一次做完 —— 分批是为了
        # 不把长事务压在用户表上(与 0143 同一个理由)。
        migrations.RunPython(backfill_search_keys, migrations.RunPython.noop),
    ]
