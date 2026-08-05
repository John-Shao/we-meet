"""``lark_md`` → span 数组。

外部可控输入的解析器,所以两类断言都要有:**认得对**(常见写法都能切出结构),
以及**认不出时不出事**(乱写的尖括号当普通文字,不抛异常、不产出可点的链接)。
"""

import pytest

from core.services import lark_md


def spans(text: str) -> list[dict]:
    return lark_md.parse(text)


# ---- 强调 -------------------------------------------------------------------


def test_bold_and_italic_become_flags_not_markup():
    assert spans("分支 **main** 于 *02:14*") == [
        {"tag": "text", "text": "分支 "},
        {"tag": "text", "text": "main", "b": True},
        {"tag": "text", "text": " 于 "},
        {"tag": "text", "text": "02:14", "i": True},
    ]


def test_bold_wins_over_italic():
    """``**x**`` 必须先于 ``*x*`` 匹配,否则粗体会被切成两个空斜体。"""
    assert spans("**x**") == [{"tag": "text", "text": "x", "b": True}]


def test_plain_text_survives_untouched():
    assert spans("就是一句话") == [{"tag": "text", "text": "就是一句话"}]


def test_optional_flags_are_omitted_not_false():
    """缺省省略键 —— 客户端按 `in` 判断,一个 false 会让 diff 里全是噪音。"""
    (span,) = spans("普通")
    assert "b" not in span and "i" not in span


# ---- 链接 -------------------------------------------------------------------


def test_markdown_link():
    assert spans("[日志](https://ci.example.com/1)") == [
        {"tag": "a", "text": "日志", "href": "https://ci.example.com/1"}
    ]


def test_html_anchor():
    assert spans("<a href='https://x.test/a'>去看看</a>") == [
        {"tag": "a", "text": "去看看", "href": "https://x.test/a"}
    ]


@pytest.mark.parametrize(
    "href",
    ["javascript:alert(1)", "data:text/html;base64,PHN2Zz4=", "file:///etc/passwd", "ftp://x/y"],
)
def test_non_web_scheme_keeps_the_words_and_drops_the_link(href):
    """webhook 正文是外部可控的,一条 ``javascript:`` href 就是一个可点的攻击面。

    降级成纯文本而不是整段丢掉 —— 丢掉会让人以为机器人没发消息。
    """
    out = spans(f"[点我]({href})")
    assert out == [{"tag": "text", "text": "点我"}]
    assert all(s["tag"] != "a" for s in out)


# ---- @ ----------------------------------------------------------------------


def test_at_everyone():
    assert spans("<at id=all></at> 请处理") == [
        {"tag": "at", "uid": "all", "name": "所有人"},
        {"tag": "text", "text": " 请处理"},
    ]


def test_at_person_uses_the_label_the_sender_wrote():
    """绝不拿 id 反查目录 —— 那会把一个泄漏的 webhook URL 变成人名枚举接口。"""
    assert spans("<at id=ou_abc>小王</at>") == [
        {"tag": "at", "uid": "ou_abc", "name": "小王"}
    ]


def test_at_without_label_falls_back_to_the_id():
    assert spans("<at id=ou_abc></at>") == [
        {"tag": "at", "uid": "ou_abc", "name": "ou_abc"}
    ]


# ---- font 降级 ---------------------------------------------------------------


def test_font_color_degrades_to_plain_text_with_a_warning():
    """双端都有深色模式,外部服务钦定的硬编码色我们保证不了对比度。"""
    warnings: list[str] = []
    out = lark_md.parse("<font color='red'>危险</font>", warnings=warnings)
    assert out == [{"tag": "text", "text": "危险"}]
    assert warnings == [lark_md.WARN_FONT_COLOR]


def test_font_warning_is_not_repeated():
    warnings: list[str] = []
    lark_md.parse("<font color='red'>a</font><font color='blue'>b</font>", warnings=warnings)
    assert warnings == [lark_md.WARN_FONT_COLOR]


# ---- 健壮性 ------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "<at id=>",
        "<a href=>x</a>",
        "未闭合 <font color='red'>",
        "[没有右括号](https://x.test",
        "**",
        "*",
        "<<<>>>",
        "",
    ],
)
def test_malformed_input_never_raises(text):
    """对方少写一个尖括号,不该变成我们的 500。"""
    lark_md.parse(text)


def test_href_may_contain_balanced_parens():
    """合法 URL 里就有括号(维基百科的 ``Foo_(bar)``)。href 停在第一个 ``)``
    会把它截断成坏链接,还在正文里留一个裸右括号。"""
    url = "https://en.wikipedia.org/wiki/Foo_(bar)"
    assert spans(f"[条目]({url})") == [{"tag": "a", "text": "条目", "href": url}]


def test_plain_projection_reads_as_prose():
    out = spans("分支 **main** 失败,[日志](https://x.test/1)<at id=all></at>")
    assert lark_md.spans_plain(out) == "分支 main 失败,日志@所有人"
