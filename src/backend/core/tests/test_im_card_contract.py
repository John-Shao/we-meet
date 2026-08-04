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


def test_optional_keys_are_absent_not_null():
    """Clients branch on presence — a null would read as 'changed to nothing'."""
    card = im_cards.build_event_card(
        event_id="e",
        title="t",
        start="2026-08-10T02:00:00+00:00",
        end="2026-08-10T03:00:00+00:00",
    )
    for key in ("old_start", "old_end", "added_count", "removed_count"):
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
    assert "shared_by" not in im_cards.build_doc_card(
        doc_id="d", title="t", url="u"
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
    assert im_cards.build_meeting_card(slug="s", title="t", status="???")[
        "status"
    ] == "ongoing"


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
