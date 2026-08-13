"""Golden-fixture contract for the three rich IM card protocols (P10 M1-g).

The fixtures under ``core/tests/fixtures/im_cards/`` are the shared truth for
three independent implementations:

  - backend   `core/services/im_cards.py`               (asserted here)
  - Web       `features/im/components/{meetingCard,docCard,eventCard}.ts`
  - Android   `feature-im/.../model/MessageContent.kt`

Each client's test suite parses these same files, so changing a protocol means
updating a fixture — a visible diff in review — rather than silently breaking
one of the other two. That, not a runtime registry, is what actually stops
three-way drift.

Regenerate deliberately with ``WRITE_IM_CARD_FIXTURES=1 pytest
core/tests/test_im_card_contract.py`` and commit the result.
"""

import json
import os
from pathlib import Path

import pytest

from core.services import im_cards
from core.services.bot_webhook import AT_EVERYONE

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "im_cards"
WRITE = os.environ.get("WRITE_IM_CARD_FIXTURES") == "1"


def _assert_golden(name: str, card: dict) -> None:
    """Compare against the committed fixture, or rewrite it when asked."""
    path = FIXTURE_DIR / f"{name}.json"
    serialized = json.dumps(card, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if WRITE:
        FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")
        return
    assert path.exists(), (
        f"missing fixture {path.name} — regenerate with "
        f"WRITE_IM_CARD_FIXTURES=1 and commit it"
    )
    assert path.read_text(encoding="utf-8") == serialized, (
        f"{path.name} drifted from the builder. If the protocol change is "
        f"intended, regenerate the fixtures AND update the Web/Android parsers."
    )


# --- event-card --------------------------------------------------------------


def test_event_card_created():
    _assert_golden(
        "event_card_created",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            attendee_count=4,
            organizer_name="张三",
        ),
    )


def test_all_day_event_card_uses_canonical_dates():
    _assert_golden(
        "event_card_all_day",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="Company holiday",
            start="2026-08-11T16:00:00+00:00",
            end="2026-08-13T16:00:00+00:00",
            kind=im_cards.EVENT_KIND_TIME_CHANGED,
            all_day=True,
            start_date="2026-08-12",
            end_date="2026-08-14",
            old_start="2026-08-09T16:00:00+00:00",
            old_end="2026-08-11T16:00:00+00:00",
            old_start_date="2026-08-10",
            old_end_date="2026-08-12",
            attendee_count=2,
            organizer_name="Alice",
        ),
    )


def test_private_event_card_redacts_conversation_metadata():
    _assert_golden(
        "event_card_private",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            attendee_count=0,
            organizer_name="",
            visibility="private",
        ),
    )


def test_event_card_invited():
    _assert_golden(
        "event_card_invited",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_INVITED,
            attendee_count=4,
            organizer_name="张三",
        ),
    )


def test_event_card_time_changed_carries_the_old_window():
    _assert_golden(
        "event_card_time_changed",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-11T02:00:00+00:00",
            end="2026-08-11T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_TIME_CHANGED,
            attendee_count=4,
            organizer_name="张三",
            old_start="2026-08-10T02:00:00+00:00",
            old_end="2026-08-10T03:00:00+00:00",
        ),
    )


def test_event_card_attendees_changed():
    _assert_golden(
        "event_card_attendees_changed",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_ATTENDEES_CHANGED,
            attendee_count=6,
            organizer_name="张三",
            added_count=2,
        ),
    )


def test_event_card_cancelled():
    _assert_golden(
        "event_card_cancelled",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_CANCELLED,
            attendee_count=4,
            organizer_name="张三",
        ),
    )


def test_event_card_removed():
    _assert_golden(
        "event_card_removed",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_REMOVED,
            attendee_count=3,
            organizer_name="张三",
        ),
    )


def test_event_card_rsvp_changed():
    _assert_golden(
        "event_card_rsvp_changed",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_RSVP_CHANGED,
            attendee_count=4,
            organizer_name="张三",
            responder_name="李四",
            rsvp_status="accepted",
        ),
    )


def test_recurring_event_card_time_changed():
    _assert_golden(
        "event_card_recurrence_time_changed",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-11T02:00:00+00:00",
            end="2026-08-11T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_TIME_CHANGED,
            attendee_count=4,
            organizer_name="张三",
            old_start="2026-08-10T02:00:00+00:00",
            old_end="2026-08-10T03:00:00+00:00",
            recurrence_scope="following",
        ),
    )


def test_recurring_event_card_cancelled():
    _assert_golden(
        "event_card_recurrence_cancelled",
        im_cards.build_event_card(
            event_id="11111111-1111-4111-8111-111111111111",
            title="季度评审",
            start="2026-08-10T02:00:00+00:00",
            end="2026-08-10T03:00:00+00:00",
            kind=im_cards.EVENT_KIND_CANCELLED,
            attendee_count=4,
            organizer_name="张三",
            recurrence_scope="all",
        ),
    )


def test_optional_keys_are_absent_not_null():
    """Clients branch on presence — a null would read as 'changed to nothing'."""
    card = im_cards.build_event_card(
        event_id="e",
        title="t",
        start="2026-08-10T02:00:00+00:00",
        end="2026-08-10T03:00:00+00:00",
    )
    for key in (
        "old_start",
        "old_end",
        "added_count",
        "removed_count",
        "recurrence_scope",
        "responder_name",
        "rsvp_status",
        "start_date",
        "end_date",
        "old_start_date",
        "old_end_date",
    ):
        assert key not in card


def test_old_window_only_travels_with_time_changed():
    card = im_cards.build_event_card(
        event_id="e",
        title="t",
        start="2026-08-10T02:00:00+00:00",
        end="2026-08-10T03:00:00+00:00",
        kind=im_cards.EVENT_KIND_CREATED,
        old_start="2026-08-09T02:00:00+00:00",
        old_end="2026-08-09T03:00:00+00:00",
    )
    assert "old_start" not in card


def test_unknown_recurrence_scope_is_omitted():
    card = im_cards.build_event_card(
        event_id="e",
        title="t",
        start="2026-08-10T02:00:00+00:00",
        end="2026-08-10T03:00:00+00:00",
        recurrence_scope="bogus",
    )
    assert "recurrence_scope" not in card


# --- doc-card ----------------------------------------------------------------


def test_doc_card():
    _assert_golden(
        "doc_card",
        im_cards.build_doc_card(
            doc_id="22222222-2222-4222-8222-222222222222",
            title="产品需求文档",
            url="https://docs.example.com/docs/22222222-2222-4222-8222-222222222222/",
        ),
    )


def test_doc_card_omits_blank_shared_by():
    assert "shared_by" not in im_cards.build_doc_card(doc_id="d", title="t", url="u")


# --- calendar-card -----------------------------------------------------------


def test_calendar_card():
    _assert_golden(
        "calendar_card",
        im_cards.build_calendar_card(
            calendar_id="55555555-5555-4555-8555-555555555555",
            name="Project launch",
            owner_name="Alice",
            description="Milestones and reviews",
            subscriber_count=12,
            subscribe_url="https://meet.example.com/calendar/subscribe/signed-token",
        ),
    )


# --- meeting-card ------------------------------------------------------------


def test_meeting_card_ongoing():
    _assert_golden(
        "meeting_card_ongoing",
        im_cards.build_meeting_card(
            slug="team-standup",
            title="每日站会",
            room_id="33333333-3333-4333-8333-333333333333",
        ),
    )


def test_meeting_card_scheduled():
    _assert_golden(
        "meeting_card_scheduled",
        im_cards.build_meeting_card(
            slug="quarterly-review",
            title="季度评审",
            status="scheduled",
            room_id="44444444-4444-4444-8444-444444444444",
            scheduled_at="2026-08-10T02:00:00+00:00",
        ),
    )


def test_meeting_card_from_the_app_has_no_room_id():
    """The App shares by slug only — room_id must stay optional."""
    card = im_cards.build_meeting_card(slug="s", title="t")
    assert card["room_id"] == ""
    assert "scheduled_at" not in card


def test_unknown_status_falls_back_to_ongoing():
    assert (
        im_cards.build_meeting_card(slug="s", title="t", status="???")["status"]
        == "ongoing"
    )


# --- rich-text ---------------------------------------------------------------


def test_rich_text_simple():
    _assert_golden(
        "rich_text_simple",
        im_cards.build_rich_text(
            title="部署完成",
            content=[[{"tag": "text", "text": "生产环境已更新到 v1.2.0"}]],
            plain="部署完成 生产环境已更新到 v1.2.0",
        ),
    )


def test_rich_text_full():
    """Every tag a client must handle, in one fixture.

    The ``[图片]`` paragraph is the deliberate image degradation: bots have no
    upload channel, so an ``image_key`` would never resolve on our side.
    """
    _assert_golden(
        "rich_text_full",
        im_cards.build_rich_text(
            title="构建失败",
            content=[
                [
                    {"tag": "text", "text": "分支 main 构建失败 "},
                    {
                        "tag": "a",
                        "text": "查看日志",
                        "href": "https://ci.example.com/runs/1",
                    },
                ],
                [
                    {"tag": "at", "uid": "all", "name": "所有人"},
                    {"tag": "text", "text": " 请处理"},
                ],
                [{"tag": "text", "text": "[图片]"}],
            ],
            plain="构建失败 分支 main 构建失败 查看日志 @所有人 请处理 [图片]",
        ),
    )


def test_rich_text_omits_blank_plain_but_keeps_blank_title():
    """``title`` is always present (clients read it unconditionally); ``plain`` is
    a derived extra and follows the omit-rather-than-null rule."""
    card = im_cards.build_rich_text(content=[[{"tag": "text", "text": "hi"}]])
    assert card["title"] == ""
    assert "plain" not in card


# --- cross-cutting -----------------------------------------------------------


@pytest.mark.parametrize("content_type", im_cards.CARD_CONTENT_TYPES)
def test_content_types_are_kebab_case(content_type):
    """All three clients dispatch on these strings; casing drift breaks rendering."""
    assert content_type == content_type.lower()
    assert "_" not in content_type


def test_rich_text_content_type_is_kebab_case():
    assert im_cards.RICH_TEXT == "rich-text"


# --- @所有人 别名(C2b) --------------------------------------------------------
#
# 与上面那些不同,这份 fixture 不是某个 builder 的产物,而是**三端共享的一张
# 常量表**:客户端判「这条消息点了所有人吗」时不能只认自己 locale 的字面量,
# 否则德语同事输的 @Alle 中文同事永远收不到提醒。后端在这里只负责两件事 ——
# 守住这张表的形状,并钉住 AT_EVERYONE 确实是表里的一员。


def _aliases() -> dict:
    return json.loads(
        (FIXTURE_DIR / "mention_everyone_aliases.json").read_text(encoding="utf-8")
    )


def test_at_everyone_is_one_of_the_aliases():
    """后端写进 plain 的字面量必须在别名表里,否则客户端认不出自己发的消息。

    ``AT_EVERYONE`` 刻意**不改**:它已经冻在存量消息里,也可能出现在用户
    配好的机器人关键词闸门规则中。要做到 locale 无关,是让客户端多认几个,
    而不是让服务端换一个。
    """
    assert AT_EVERYONE.startswith("@")
    assert AT_EVERYONE.lstrip("@") in _aliases()["aliases"]


def test_alias_list_is_the_flat_projection_of_by_locale():
    """by_locale 是唯一真相,aliases 是它的扁平投影 —— 两边不能各自漂。"""
    data = _aliases()
    assert set(data["aliases"]) == set(data["by_locale"].values())
    assert len(data["aliases"]) == len(set(data["aliases"])), "别名表里有重复项"
    assert all(a.strip() == a and a for a in data["aliases"]), (
        "别名不得带首尾空白或为空"
    )


def test_alias_table_covers_every_shipped_locale():
    """漏一个语种 = 那个语种的用户被 @所有人 时不会亮 —— 静默,没人会报障。"""
    assert set(_aliases()["by_locale"]) == {"zh", "en", "fr", "de", "nl"}


# --- rich-card(A1) -----------------------------------------------------------
#
# 这三张 golden 是**协议规格**,不是「A1 的映射器今天会吐什么」。所以 full 那张
# 里带一个 callback 按钮:A1 的映射器不会产出它(installation 上还没有回调通道),
# 但客户端必须现在就认得这个形状,否则 A2 一上线双端全炸。


def test_rich_card_minimal():
    """只有一个文本块,连 header 都没有 —— 客户端不能因此崩。"""
    card = im_cards.build_rich_card(
        blocks=[
            {
                "type": "text",
                "spans": [{"tag": "text", "text": "部署完成"}],
            }
        ],
        plain="部署完成",
    )
    _assert_golden("rich_card_minimal", card)
    assert "header" not in card, "没有 header 时该省略键,不是给个 null"


def test_rich_card_full():
    """三端逐字段断言的那张:header + 三种 span + fields + divider + 三种按钮。"""
    card = im_cards.build_rich_card(
        header={"title": "生产构建失败", "theme": "danger"},
        blocks=[
            {
                "type": "text",
                "spans": [
                    {"tag": "text", "text": "分支 "},
                    {"tag": "text", "text": "main", "b": True},
                    {"tag": "text", "text": " 于 "},
                    {"tag": "text", "text": "02:14", "i": True},
                    {"tag": "text", "text": " 失败,"},
                    {
                        "tag": "a",
                        "text": "运行日志",
                        "href": "https://ci.example.com/runs/1",
                    },
                    {"tag": "at", "uid": "all", "name": "所有人"},
                ],
            },
            {
                "type": "fields",
                # 三项(奇数):客户端两列渲染时最后一项跨列,这条靠 fixture 钉住
                # 「协议只保证顺序」——跨列是客户端的事,不进协议。
                "items": [
                    {"label": "环境", "value": "生产"},
                    {"label": "耗时", "value": "4 分 12 秒"},
                    {"label": "提交", "value": "a1b2c3d 修复登录态过期"},
                ],
            },
            {"type": "divider"},
            {
                "type": "actions",
                "resolve": "once",
                "buttons": [
                    {
                        "id": "b0",
                        "text": "同意上线",
                        "style": "primary",
                        "action": "callback",
                    },
                    {
                        "id": "b1",
                        "text": "驳回",
                        "style": "danger",
                        "action": "callback",
                    },
                    {
                        "id": "b2",
                        "text": "查看日志",
                        "style": "default",
                        "action": "url",
                        "url": "https://ci.example.com/runs/1",
                    },
                ],
            },
        ],
        plain="生产构建失败 分支 main 于 02:14 失败,运行日志@所有人 环境 生产 耗时 4 分 12 秒 提交 a1b2c3d 修复登录态过期",
    )
    _assert_golden("rich_card_full", card)


def test_rich_card_degraded():
    """输入里有 img/note 时的**输出**:块少了,顺序不乱,warnings 不在 body 里。"""
    card = im_cards.build_rich_card(
        header={"title": "日报", "theme": "info"},
        blocks=[
            {"type": "text", "spans": [{"tag": "text", "text": "前一段"}]},
            {"type": "divider"},
            {"type": "text", "spans": [{"tag": "text", "text": "后一段"}]},
        ],
        plain="日报 前一段 后一段",
    )
    _assert_golden("rich_card_degraded", card)


def test_no_button_ever_carries_its_value():
    """整个回调设计里最重要的一条不变量 —— 单独一条断言,不落 fixture。

    body 是全群可读的。外部服务塞在 value 里的 pipeline token 一旦进了 body,
    就永久冻在消息历史和 jusi 的全文索引里。
    """
    # 按**键名白名单**断言,而不是在整个 JSON 里 grep "value" —— fields 的
    # {label, value} 是展示数据,本来就该叫这个名字,两者只是撞了字面量。
    allowed = {"id", "text", "style", "action", "url"}
    card = json.loads((FIXTURE_DIR / "rich_card_full.json").read_text(encoding="utf-8"))
    seen = 0
    for block in card["blocks"]:
        for button in block.get("buttons", []):
            extra = set(button) - allowed
            assert not extra, f"button {button.get('id')} 把 {extra} 带进了 body"
            seen += 1
    assert seen >= 3, "fixture 里应当有按钮,否则这条断言在空转"


def test_rich_card_always_carries_a_version():
    """v 缺失时客户端没法分辨「老协议」和「坏 JSON」。"""
    card = im_cards.build_rich_card(blocks=[{"type": "divider"}])
    assert card["v"] == 1


def test_rich_card_content_types_are_kebab_case():
    assert im_cards.RICH_CARD == "rich-card"
    assert im_cards.CARD_STATE == "card-state"
