"""中文姓名的拼音排序键与首字母 —— 通讯录 A–Z 索引的地基。

为什么需要:汉字的编码序不是拼音序,而「全部成员」动辄上千人 —— 列表既无法按
拼音排,也没法按首字母跳转。这两个派生值在 ``User.save()`` 里重算(见
``models.User``),列表按 ``full_name_pinyin`` 排序、按 ``full_name_initial``
分桶,首字母计数走 ``DirectoryMemberViewSet.alphabet``。

    >>> pinyin_sort_key("张三")
    '0zhangsan'
    >>> pinyin_sort_key("John Doe")
    '0johndoe'
    >>> pinyin_sort_key("1001")
    '11001'
    >>> pinyin_initial("张三")
    'Z'
    >>> pinyin_initial("1001")
    '#'

非中文按原样参与排序(英文名照字母序),数字/符号/空名字统一进 ``#`` 一桶 ——
那一桶的键以 ``1`` 开头,于是在名册里永远排在最后,而不是因为 ASCII 比 'A' 小
就窜到最前面(键以字母桶的 ``0`` 开头)。
"""

import unicodedata

from pypinyin import Style, lazy_pinyin

#: 分不出首字母时的桶(通讯录索引里排在 A–Z 之后)。
OTHER_INITIAL = "#"

#: 排序键的**桶类前缀**:字母桶 ``0``、``#`` 桶 ``1``。桶序于是成为键的一部分,
#: 查询侧 ``ORDER BY full_name_pinyin`` 就够 —— 不需要表达式,索引才用得上。
#:
#: 为什么必须是**数字**而不是标点:数据库的 collation 是 ``en_US.utf8``(postgres 镜像
#: 默认),它在主比较级别上**忽略标点**。实测 ``SELECT '~1001' < 'abao'`` 为真 ——
#: 用 ``~`` 当「排在最后」的前缀,`#` 桶反而被顶到名册最前面。数字是真实的比较级别:
#: 实测 ``'0zhangsan' < '1zhangsan'`` 恒成立,与 collation 无关。
#:
#: 另一个陷阱是别把桶序交给 ``ORDER BY CASE …``:首列是表达式时 ``full_name_pinyin``
#: 的索引完全用不上,整个组织要先物化再排序(5000 人名册、热缓存实测:``CASE`` 写法
#: 3.6 ms 且计划里是一个 5000 行的 Sort,去掉之后 0.11 ms、Limit → Index Scan)。
LETTER_KEY_PREFIX = "0"
OTHER_KEY_PREFIX = "1"

#: ``User.full_name_pinyin`` 的字段宽度,超出截断 —— 姓名本身最多 100 字。
MAX_SORT_KEY_LENGTH = 255

#: NFD 拆不开的那几个欧洲字母(一个字就是一个字母,不是「基字母 + 变音符号」)。
#: 上面先 lower 过,所以只需要小写这一侧。
#:
#: 不映射的后果很具体:Émile 会掉进 '#' 桶 —— 也就是被归到「其他(数字或符号)」,
#: 排在整册人最后面。而本产品明确支持 fr / de / nl,带音标的姓名不是边角情况。
_NON_DECOMPOSABLE = str.maketrans(
    {
        "ø": "o",  # 丹麦语/挪威语 Ørsted
        "ł": "l",  # 波兰语 Łukasz
        "đ": "d",
        "ð": "d",
        "þ": "t",
        "æ": "ae",
        "œ": "oe",
        "ß": "ss",
        "ı": "i",
    }
)


def _fold_latin(text: str) -> str:
    """把带音标的拉丁字母折成 ASCII:é→e、ñ→n、Ø→o……

    两个好处:
    1. 排序键变成纯 ASCII,于是「按拼音排」不依赖数据库的 collation —— 换一个
       locale 的 Postgres,顺序不会跟着变。
    2. 首字母判断能落在 a–z 上,Émile 排到 E 而不是 '#'。
    """
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.translate(_NON_DECOMPOSABLE)


def _folded_key(name: str | None) -> str:
    """姓名 → 折叠后的小写拼音串(**不含**桶前缀)。首字母就是看它的第一个字符。

    ``errors="default"`` 让非汉字原样带过:英文名照字母序排,数字/符号也不会
    被悄悄丢掉(丢掉会让它们全挤成一个空键,排序退化成随机)。``pypinyin`` 对
    任何输入都不会抛异常(emoji、空串、300 字的姓名实测都正常),所以它在
    ``User.save()`` 里跑不会把「保存用户」这件事拖下水。
    """
    cleaned = (name or "").strip()
    if not cleaned:
        return ""
    syllables = lazy_pinyin(cleaned, style=Style.NORMAL, errors="default")
    # 名字里的空格/全角空格不参与比较:"张 三"和"张三"要排在同一个位置。
    joined = "".join("".join(syllables).split()).lower()
    return _fold_latin(joined)


def pinyin_sort_key(name: str | None) -> str:
    """姓名 → 排序键:桶类前缀 + 折叠后的拼音串。

    字母桶 ``0`` 在前、``#`` 桶 ``1`` 在后,所以「# 排最后」是**数据**的一部分,
    查询侧 ``ORDER BY full_name_pinyin`` 就够(不需要表达式,索引才用得上)。
    """
    folded = _folded_key(name)
    prefix = (
        LETTER_KEY_PREFIX
        if folded and "a" <= folded[0] <= "z"
        else OTHER_KEY_PREFIX
    )
    return (prefix + folded)[:MAX_SORT_KEY_LENGTH]


def pinyin_initial(name: str | None) -> str:
    """姓名 → A–Z 里的首字母;数字/符号/空名字 → ``#``。

    看的是**折叠后的键**而不是排序键 —— 后者带桶类前缀(``0``/``1``),那是排序用的。
    """
    folded = _folded_key(name)
    if not folded:
        return OTHER_INITIAL
    first = folded[0]
    return first.upper() if "a" <= first <= "z" else OTHER_INITIAL
