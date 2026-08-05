"""飞书 ``interactive`` → ``rich-card`` 的映射。

payload fixture 在 ``core/tests/fixtures/bot_payloads/`` —— 与 ``im_cards/``
那批不同,**这批不进三端契约**:它们是「外部会发来什么」的样本,只有后端读。
"""

import json
from pathlib import Path

import pytest

from core.services import bot_cards, im_cards
from core.services.bot_webhook import (
    CODE_EMPTY_CONTENT,
    CODE_TEMPLATE_UNSUPPORTED,
    BotPayloadError,
    build_message,
)

PAYLOAD_DIR = Path(__file__).parent.parent / "fixtures" / "bot_payloads"

SECRET = "SECRET-PIPELINE-TOKEN"


def payload(name: str) -> dict:
    return json.loads((PAYLOAD_DIR / f"{name}.json").read_text(encoding="utf-8"))


# ---- 一套管线吃两代 schema ---------------------------------------------------


def test_v1_and_v2_produce_byte_identical_bodies():
    """**这条是「一套映射管线」那个设计的全部证据。**

    两个 fixture 表达的是同一张卡,只是 1.0 / 2.0 两种写法。产出必须逐字节
    相同 —— 一旦不同,就说明有人给 2.0 开了第二条降级路径,而两条路径必然漂。
    """
    v1 = bot_cards.map_card(payload("interactive_v1"), allow_callback=True)
    v2 = bot_cards.map_card(payload("interactive_v2"), allow_callback=True)
    assert json.dumps(v1.body, sort_keys=True) == json.dumps(v2.body, sort_keys=True)
    assert v1.button_values == v2.button_values


def test_v1_maps_every_block_kind():
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=True)
    assert mapped.body["header"] == {"title": "生产构建失败", "theme": "danger"}
    assert [b["type"] for b in mapped.body["blocks"]] == [
        "text",
        "fields",
        "divider",
        "actions",
    ]


def test_lark_md_becomes_spans_not_a_markdown_string():
    """下发 markdown 会逼三端各写一个渲染器,Web 那边迟早出 dangerouslySetInnerHTML。"""
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=True)
    spans = mapped.body["blocks"][0]["spans"]
    assert {"tag": "text", "text": "main", "b": True} in spans
    assert {"tag": "at", "uid": "all", "name": "所有人"} in spans
    assert any(s["tag"] == "a" and s["href"].startswith("https://") for s in spans)
    assert not any("**" in str(s.get("text", "")) for s in spans)


def test_fields_are_split_into_label_and_value():
    """飞书惯例是 ``**标签**\\n值``。拆在服务端,否则三端各写一遍「第一行当标签」。"""
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=True)
    items = mapped.body["blocks"][1]["items"]
    assert items == [
        {"label": "环境", "value": "生产"},
        {"label": "耗时", "value": "4 分 12 秒"},
        {"label": "提交", "value": "a1b2c3d 修复登录态过期"},
    ]


# ---- value 不进 body(最重要的一条)------------------------------------------


def test_button_value_never_reaches_the_body():
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=True)
    serialized = json.dumps(mapped.body, ensure_ascii=False)
    assert SECRET not in serialized
    for block in mapped.body["blocks"]:
        for button in block.get("buttons", []):
            assert set(button) <= {"id", "text", "style", "action", "url"}


def test_button_value_is_returned_separately_keyed_by_id():
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=True)
    (callback_button,) = [
        b
        for block in mapped.body["blocks"]
        for b in block.get("buttons", [])
        if b["action"] == "callback"
    ]
    assert mapped.button_values[callback_button["id"]]["token"] == SECRET


def test_secret_never_reaches_the_body_through_build_message_either():
    """端到端一遍:走公开入口也不能漏。"""
    message = build_message(payload("interactive_v1"), allow_callback=True)
    assert message.content_type == im_cards.RICH_CARD
    assert SECRET not in message.body
    assert SECRET not in message.plain


# ---- A1:没有回调通道时,callback 按钮丢掉而不是变成死按钮 ---------------------


def test_callback_button_is_dropped_with_a_warning_when_callbacks_are_off():
    """渲染一个点了没反应的按钮比不渲染更糟 —— 用户会一直点。"""
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=False)
    buttons = [b for block in mapped.body["blocks"] for b in block.get("buttons", [])]
    assert [b["action"] for b in buttons] == ["url"]
    assert bot_cards.WARN_BUTTON_CALLBACK_UNAVAILABLE in mapped.warnings
    assert mapped.button_values == {}


def test_dropping_a_button_does_not_leave_a_hole_in_the_id_sequence():
    """id 是位置生成的。丢掉一个按钮却把它的号也用掉,会让剩下的 id 无谓地跳号。"""
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=False)
    (button,) = [b for block in mapped.body["blocks"] for b in block.get("buttons", [])]
    assert button["id"] == "b0"


def test_url_buttons_work_without_callbacks():
    """A1 的卖点:用户拿到完整体验,没有一个死按钮。"""
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=False)
    (button,) = [b for block in mapped.body["blocks"] for b in block.get("buttons", [])]
    assert button["url"] == "https://ci.example.com/runs/1"


# ---- 降级三级 ----------------------------------------------------------------


def test_unsupported_blocks_are_dropped_with_a_warning_and_the_message_still_goes():
    card = {
        "msg_type": "interactive",
        "card": {
            "header": {"title": {"content": "日报"}, "template": "blue"},
            "elements": [
                {"tag": "div", "text": {"content": "前一段"}},
                {"tag": "img", "img_key": "img_x"},
                {"tag": "note", "elements": []},
                {"tag": "hr"},
                {"tag": "div", "text": {"content": "后一段"}},
            ],
        },
    }
    mapped = bot_cards.map_card(card, allow_callback=False)
    # 剩下的块顺序不能乱。
    assert [b["type"] for b in mapped.body["blocks"]] == ["text", "divider", "text"]
    assert "block-dropped:img" in mapped.warnings
    assert "block-dropped:note" in mapped.warnings


def test_warnings_never_travel_in_the_body():
    """群成员不该看到「你的机器人少发了一张图」。"""
    mapped = bot_cards.map_card(payload("interactive_all_dropped") | {
        "card": {
            "header": {"title": {"content": "x"}},
            "elements": [{"tag": "img", "img_key": "k"}],
        }
    }, allow_callback=False)
    assert mapped.warnings
    assert "warning" not in json.dumps(mapped.body)


def test_everything_dropped_is_an_error_not_an_empty_card():
    with pytest.raises(BotPayloadError) as exc:
        bot_cards.map_card(payload("interactive_all_dropped"), allow_callback=False)
    assert exc.value.code == CODE_EMPTY_CONTENT


def test_card_templates_are_a_hard_error_not_a_blank_card():
    """模板内容住在飞书那边,我们既取不到也渲染不了。静默发空卡比报错难查得多。"""
    with pytest.raises(BotPayloadError) as exc:
        bot_cards.map_card(payload("interactive_template"), allow_callback=False)
    assert exc.value.code == CODE_TEMPLATE_UNSUPPORTED


@pytest.mark.parametrize("bad", [None, [], "card", {"card": "not-an-object"}, {"card": {"elements": "x"}}])
def test_structurally_broken_payloads_raise_rather_than_500(bad):
    with pytest.raises(BotPayloadError):
        bot_cards.map_card(bad if isinstance(bad, dict) else {"card": bad}, allow_callback=False)


# ---- 主题 --------------------------------------------------------------------


@pytest.mark.parametrize(
    "template,theme",
    [
        ("red", "danger"),
        ("carmine", "danger"),
        ("green", "success"),
        ("turquoise", "success"),
        ("yellow", "warning"),
        ("orange", "warning"),
        ("blue", "info"),
        ("indigo", "info"),
        ("grey", "neutral"),
        ("", "neutral"),
        ("chartreuse-of-tomorrow", "neutral"),
    ],
)
def test_twelve_templates_collapse_to_five_semantic_themes(template, theme):
    """协议里写 "red" 就逼三端各自拥有一个红;写 "danger" 让每端取自己主题里
    **已经保证过深浅对比度**的那个 token。认不出的一律 neutral,不是崩。"""
    card = {
        "card": {
            "header": {"title": {"content": "t"}, "template": template},
            "elements": [{"tag": "hr"}],
        }
    }
    mapped = bot_cards.map_card(card, allow_callback=False)
    assert mapped.body["header"]["theme"] == theme
    assert theme in im_cards.CARD_THEMES


def test_header_without_a_title_is_omitted_not_nulled():
    card = {"card": {"header": {"template": "red"}, "elements": [{"tag": "hr"}]}}
    mapped = bot_cards.map_card(card, allow_callback=False)
    assert "header" not in mapped.body


# ---- 限额 --------------------------------------------------------------------


def test_more_than_five_buttons_are_truncated_with_a_warning():
    card = {
        "card": {
            "elements": [
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"content": f"b{i}"},
                            "url": f"https://x.test/{i}",
                        }
                        for i in range(8)
                    ],
                }
            ]
        }
    }
    mapped = bot_cards.map_card(card, allow_callback=False)
    assert len(mapped.body["blocks"][0]["buttons"]) == bot_cards.MAX_BUTTONS_PER_BLOCK
    assert bot_cards.WARN_BUTTONS_TRUNCATED in mapped.warnings


def test_plain_projection_skips_button_labels():
    """按钮是可点的控件不是话。进了预览会读成「构建失败 同意上线 查看日志」,
    像机器人在念按钮。"""
    mapped = bot_cards.map_card(payload("interactive_v1"), allow_callback=True)
    plain = mapped.body["plain"]
    assert "生产构建失败" in plain
    assert "环境 生产" in plain
    assert "同意上线" not in plain
    assert "查看日志" not in plain
