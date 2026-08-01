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


# --- cross-cutting -----------------------------------------------------------


@pytest.mark.parametrize("content_type", im_cards.CARD_CONTENT_TYPES)
def test_content_types_are_kebab_case(content_type):
    """All three clients dispatch on these strings; casing drift breaks rendering."""
    assert content_type == content_type.lower()
    assert "_" not in content_type
