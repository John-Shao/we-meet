"""Placeholder normalization must not guess owners or weaken citation checks."""

import json
from types import SimpleNamespace

import pytest

from core.services.meeting_summary_versions import validate_output
from core.services.summary_facts import normalize_owner


@pytest.mark.parametrize(
    "value",
    [
        "Unknown speaker",
        " unknown  SPEAKER ",
        "Unknown speaker (I)",
        "Speaker (I)",
        "说话人（我）",
        "Speaker 2",
        "说话人 １",
        "未知发言人",
        "TBD",
    ],
)
def test_placeholder_owner_is_blank(value):
    assert (
        normalize_owner(value, [{"speaker_name": value, "speaker_identity": ""}]) == ""
    )


@pytest.mark.parametrize(
    "value",
    [
        "Alice",
        "陈晨",
        "主持人",
        "Speaker Smith",
        "Alice / Bob",
        "Unknown Research Team",
    ],
)
def test_named_people_and_explicit_roles_are_preserved(value):
    assert normalize_owner(value, []) == value


def test_real_attribution_is_preserved_without_assigning_other_speakers():
    assert (
        normalize_owner(
            "Speaker 2", [{"speaker_name": "Speaker 2", "speaker_identity": "user-2"}]
        )
        == "Speaker 2"
    )
    assert (
        normalize_owner(
            "Unknown speaker", [{"speaker_name": "Alice", "speaker_identity": "user-1"}]
        )
        == ""
    )


def test_normalization_keeps_citations_and_does_not_replace_bad_references():
    row = {
        "segment_id": "one",
        "segment_revision": 2,
        "start_ms": 0,
        "end_ms": 1000,
        "text": "I will review.",
        "speaker_identity": "",
        "speaker_name": "Unknown speaker",
    }
    ref = {k: row[k] for k in ("segment_id", "segment_revision", "start_ms", "end_ms")}
    raw = {
        "overview": "Review requested",
        "decisions": [],
        "chapters": [],
        "open_questions": [],
        "action_items": [
            {
                "text": "Review",
                "source_refs": [ref],
                "owner_text": "Unknown speaker",
                "due_text": "before Thursday afternoon",
            }
        ],
    }
    result = validate_output(json.dumps(raw), SimpleNamespace(segments=[row]))
    assert result["action_items"][0]["owner_text"] == ""
    assert result["action_items"][0]["source_refs"] == [ref]
    assert result["action_items"][0]["due_text"] == "before Thursday afternoon"
    ref["segment_id"] = "other-record"
    with pytest.raises(ValueError, match="Reference"):
        validate_output(json.dumps(raw), SimpleNamespace(segments=[row]))
