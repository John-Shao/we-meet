"""中文姓名的拼音排序键与首字母 —— 通讯录 A–Z 索引的地基。

为什么需要:汉字的编码序不是拼音序,而「全部成员」动辄上千人 —— 列表既无法按
拼音排,也没法按首字母跳转。这两个派生值在 ``User.save()`` 里重算(见
``models.User``),列表按 ``full_name_pinyin`` 排序、按 ``full_name_initial``
分桶,首字母计数走 ``DirectoryMemberViewSet.alphabet``。

    >>> pinyin_sort_key("张三")
    'zhangsan'
    >>> pinyin_sort_key("John Doe")
    'johndoe'
    >>> pinyin_initial("张三")
    'Z'
    >>> pinyin_initial("1001")
    '#'

非中文按原样参与排序(英文名照字母序),数字/符号/空名字统一进 ``#`` 一桶 ——
那一桶在通讯录里永远排在最后,而不是因为 ASCII 比 'A' 小就窜到最前面。
"""

import unicodedata

from pypinyin import Style, lazy_pinyin

#: 分不出首字母时的桶(通讯录索引里排在 A–Z 之后)。
OTHER_INITIAL = "#"

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


def pinyin_sort_key(name: str | None) -> str:
    """姓名 → 小写拼音串(去空白、折成 ASCII),用作排序键。

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
    return _fold_latin(joined)[:MAX_SORT_KEY_LENGTH]


def pinyin_initial(name: str | None) -> str:
    """姓名 → A–Z 里的首字母;数字/符号/空名字 → ``#``。"""
    key = pinyin_sort_key(name)
    if not key:
        return OTHER_INITIAL
    first = key[0]
    return first.upper() if "a" <= first <= "z" else OTHER_INITIAL
