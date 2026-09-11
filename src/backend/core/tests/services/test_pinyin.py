"""通讯录 A–Z 索引的拼音基础:排序键与首字母。

这两个函数是「列表怎么排」和「点字母跳到哪」的唯一真相,所以边界要钉死:
空名字、数字、英文、混排、全角空格,以及——「分不出首字母」必须统一进 ``#``。
"""

import importlib

import pytest

from core.services import pinyin


@pytest.mark.parametrize(
    "name,expected",
    [
        ("张三", "0zhangsan"),
        ("李四", "0lisi"),
        ("欧阳修", "0ouyangxiu"),
        ("John Doe", "0johndoe"),
        ("ALICE", "0alice"),
        ("王Alice", "0wangalice"),
        # 名字里的空格不参与比较:"张 三"和"张三"要排在同一个位置。
        ("张 三", "0zhangsan"),
        ("张\u3000三", "0zhangsan"),
        ("  李四  ", "0lisi"),
        # 认不出的字符原样保留,但整桶换 '1' 前缀 —— 前缀让「# 排最后」成为**数据**
        # 的一部分,查询侧因此不必写 CASE 表达式,索引才用得上(见 OTHER_KEY_PREFIX)。
        ("1001", "11001"),
        ("🙂", "1🙂"),
        ("Иван", "1иван"),
        ("", "1"),
    ],
)
def test_pinyin_sort_key(name, expected):
    assert pinyin.pinyin_sort_key(name) == expected


@pytest.mark.parametrize(
    "name",
    ["张三", "John", "Émile", "1001", "🙂", "", "   ", "Иван", "たなか", None],
)
def test_sort_key_prefix_matches_the_hash_bucket(name):
    """不变式:键带 ``1`` 前缀 ⇔ 首字母是 ``#``。

    两条规则分开实现的(前缀管排序、initial 管分桶)。它们一旦不一致,列表里会出现
    「排在 Z 之后但计数算进 E」这种对不上的行 —— 而那种错肉眼极难发现。
    """
    key = pinyin.pinyin_sort_key(name)
    in_hash_bucket = pinyin.pinyin_initial(name) == pinyin.OTHER_INITIAL
    assert key.startswith(pinyin.OTHER_KEY_PREFIX) is in_hash_bucket
    assert key.startswith(pinyin.LETTER_KEY_PREFIX) is (not in_hash_bucket)


def test_hash_bucket_sorts_last_by_key_alone():
    """去掉 CASE 之后,「# 桶最后」必须只靠键序就成立。

    这条曾经救过一次:最初用 ``~`` 当「排最后」的前缀,而 ``en_US.utf8`` collation
    在主级别忽略标点(``'~1001' < 'abao'`` 为真),`#` 桶反而排到了最前面。数字前缀
    没有这个问题 —— 但真正拦住它的是 DatabaseTest 里那条按真实 collation 排序的断言。
    """
    names = ["张三", "1001", "李四", "", "🙂"]
    ordered = sorted(names, key=pinyin.pinyin_sort_key)
    # 字母桶在前(按拼音),# 桶整桶在后;空名字的键就是 '1',所以排在桶内最前。
    assert ordered == ["李四", "张三", "", "1001", "🙂"]


@pytest.mark.parametrize(
    "name,expected",
    [
        ("张三", "Z"),
        ("李四", "L"),
        ("欧阳修", "O"),
        ("阿宝", "A"),
        ("John", "J"),
        ("alice", "A"),
        # 带音标的拉丁名:Émile 属于 E,不是「其他」。产品支持 fr/de/nl,这不是边角。
        ("Émile", "E"),
        ("Öztürk", "O"),
        ("Åberg", "A"),
        ("Çelik", "C"),
        ("Ñuñez", "N"),
        ("Ørsted", "O"),  # NFD 拆不开,靠显式映射
        ("Łukasz", "L"),  # 同上
        ("José", "J"),
        ("1001", pinyin.OTHER_INITIAL),
        ("🙂", pinyin.OTHER_INITIAL),
        # 非拉丁、非汉字的文字没有首字母可谈(索引条上没有它们的字母):
        # 统一进 '#' 桶,而不是按码点散落在 A–Z 中间。
        ("Иван", pinyin.OTHER_INITIAL),
        ("たなか", pinyin.OTHER_INITIAL),
        ("김철수", pinyin.OTHER_INITIAL),
        ("Γιώργος", pinyin.OTHER_INITIAL),
        ("", pinyin.OTHER_INITIAL),
        (None, pinyin.OTHER_INITIAL),
        ("   ", pinyin.OTHER_INITIAL),
    ],
)
def test_pinyin_initial(name, expected):
    assert pinyin.pinyin_initial(name) == expected


def test_pinyin_sort_key_folds_accents_to_ascii():
    """排序键折成 ASCII:带音标的名字要排在同一个字母里,而不是「Z 之后、# 之前」。"""
    assert pinyin.pinyin_sort_key("Émile") == "0emile"
    assert pinyin.pinyin_sort_key("Öztürk") == "0ozturk"
    assert pinyin.pinyin_sort_key("Ørsted") == "0orsted"
    assert pinyin.pinyin_sort_key("Łukasz") == "0lukasz"

    names = ["Zoe", "Émile", "Adam"]
    assert sorted(names, key=pinyin.pinyin_sort_key) == ["Adam", "Émile", "Zoe"]


def test_pinyin_never_raises_on_hostile_input():
    """它跑在 User.save() 里 —— 任何输入抛异常都等于「用户存不进去」。

    这里钉的是最脏的几种:emoji、只有空白、超长、控制字符、代理对。
    """
    for name in ["🙂", "  ", "X" * 500, "\x00\x01", "\ud83d\ude00", "·"]:
        assert isinstance(pinyin.pinyin_sort_key(name), str)
        assert isinstance(pinyin.pinyin_initial(name), str)


def test_migration_copy_matches_service():
    """迁移里那份冻结副本必须与 service 逐字同效。

    不一致的后果肉眼看不出来:迁移回填出来的顺序和新用户保存后的顺序会不一样,
    索引条与列表就错位了。导入用 importlib —— 模块名以数字开头,写不了 import 语句。

    盯的是**最新**的那两份副本(0144 的排序键、0145 的搜索键)。``0143`` 里那份
    **故意保持旧规则**:它代表历史上的一次回填,已经跑过的迁移不能跟着新算法改 ——
    改它等于声称当时写进去的是别的值。
    """
    frozen = importlib.import_module("core.migrations.0144_pinyin_sort_key_bucket")
    for name in [
        "张三",
        "李四",
        "欧阳修",
        "John Doe",
        "Émile",
        "Ørsted",
        "Łukasz",
        "1001",
        "🙂",
        "Иван",
        "",
        None,
        "  ",
        "张 三",
        "X" * 400,
    ]:
        assert frozen._sort_key(name) == pinyin.pinyin_sort_key(name), name
        assert frozen._initial(name) == pinyin.pinyin_initial(name), name

    search_frozen = importlib.import_module("core.migrations.0145_user_search_key")
    for name, short_name in [
        ("夜来香", None),
        ("张三", "三儿"),
        ("张三", ""),
        ("欧阳修", None),
        ("Yelena Smith", None),
        ("John Doe", "JD"),
        ("王Alice", None),
        ("Öztürk", None),
        ("Émile", None),
        ("1001", None),
        ("🙂", None),
        ("", None),
        (None, None),
        ("  ", "  "),
        ("张 三", None),
        ("X" * 400, None),
    ]:
        assert search_frozen._search_key(name, short_name) == pinyin.pinyin_search_key(
            name, short_name
        ), f"{name!r} / {short_name!r}"


def test_pinyin_search_key_packs_full_pinyin_and_initials():
    """词袋 = 全拼 + 首字母缩写(简称的同两样),空格分开。

    这两样分别对应两种输法:输入 ``ye`` 靠 ``yelaixiang``、输入 ``ylx`` 靠 ``ylx``。
    用户不用知道这个区别,但**两个词都得在**。
    """
    assert pinyin.pinyin_search_key("夜来香") == "yelaixiang ylx"
    assert pinyin.pinyin_search_key("张三") == "zhangsan zs"
    assert pinyin.pinyin_search_key("欧阳修") == "ouyangxiu oyx"
    # 拉丁名:全拼是「去掉空格的整串」,缩写是每个词的首字母。
    assert pinyin.pinyin_search_key("Yelena Smith") == "yelenasmith ys"
    assert pinyin.pinyin_search_key("John Doe") == "johndoe jd"
    # 混合姓名:汉字与拉丁词各取各的首字母。
    assert pinyin.pinyin_search_key("王Alice") == "wangalice wa"
    # 简称也进袋(很多人用简称当常用称呼),但重复的词只留一份。
    assert pinyin.pinyin_search_key("张三", "三儿") == "zhangsan zs saner se"
    assert pinyin.pinyin_search_key("张三", "张三") == "zhangsan zs"
    # 音标折叠:输入 ozturk 也能命中 Öztürk。
    assert "ozturk" in pinyin.pinyin_search_key("Öztürk")
    assert pinyin.pinyin_search_key("") == ""
    assert pinyin.pinyin_search_key(None) == ""
    assert pinyin.pinyin_search_key("  ") == ""


def test_pinyin_search_key_covers_the_users_case():
    """用户诉求原话:输入 ``ye``,把「夜来香」搜出来。

    这条测试就是那句话的可执行版本 —— 键里必须**包含** ``ye``(前缀命中),
    而不只是「包含 ye 开头的某个词」。
    """
    key = pinyin.pinyin_search_key("夜来香")
    assert "ye" in key
    assert "ylx" in key
    assert "yelaixiang" in key
    assert "lai" in key
    # 反面:不相干的输入不该命中(否则搜索会看起来「什么都搜得到」)。
    assert "xy" not in key
    assert "san" not in key


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Ye", "ye"),
        ("  Ye Lai  ", "yelai"),
        ("Yè", "ye"),
        ("ÖZTÜRK", "ozturk"),
        ("ylx", "ylx"),
        # 汉字原样保留:它交给 full_name__icontains,不在这里转拼音。
        ("夜", "夜"),
        ("", ""),
        (None, ""),
        ("   ", ""),
    ],
)
def test_fold_search_query(raw, expected):
    """查询词与键用同一套折叠:小写 + 折音标 + 去空白。"""
    assert pinyin.fold_search_query(raw) == expected


def test_pinyin_search_key_is_bounded():
    """超长姓名别把字段撑爆(max_length=255)。"""
    assert len(pinyin.pinyin_search_key("张" * 400)) == pinyin.MAX_SEARCH_KEY_LENGTH
    assert (
        len(pinyin.pinyin_search_key("X" * 400, "Y" * 400))
        == pinyin.MAX_SEARCH_KEY_LENGTH
    )


def test_pinyin_sort_key_is_bounded():
    """超长名字截断,别撑爆字段(max_length=255)—— 带了桶类前缀也一样。"""
    assert len(pinyin.pinyin_sort_key("张" * 400)) == pinyin.MAX_SORT_KEY_LENGTH
    assert len(pinyin.pinyin_sort_key("1" * 400)) == pinyin.MAX_SORT_KEY_LENGTH
    assert pinyin.pinyin_sort_key("1" * 400).startswith(pinyin.OTHER_KEY_PREFIX)


def test_pinyin_order_differs_from_codepoint_order():
    """这条是整个功能的前提:汉字的编码序不是拼音序。

    张(U+5F20) < 李(U+674E) < 王(U+738B),而拼音是 li < wang < zhang ——
    两种排法必须不同,否则这一整套后端改动没有意义。
    """
    names = ["张三", "李四", "王五"]
    assert names == sorted(names)  # 编码序
    assert [pinyin.pinyin_sort_key(n) for n in names] == [
        "0zhangsan",
        "0lisi",
        "0wangwu",
    ]
    assert sorted(names, key=pinyin.pinyin_sort_key) == ["李四", "王五", "张三"]
