"""Synthetic turn/word evidence: no recording, encoder or paid provider requests."""

from copy import deepcopy

import pytest

from core.services import capture_diarization_alignment as service
from core.services import word_alignment


def turns():
    return [
        {
            "start_ms": 0,
            "end_ms": 500,
            "speaker": "0",
            "text": "Never substitute this text",
        },
        {"start_ms": 500, "end_ms": 1000, "speaker": "1"},
    ]


def evidence():
    text = "Hi 😀.  Bye!"
    data, status = word_alignment.from_sentence(
        {
            "text": text,
            "begin_time": 0,
            "end_time": 1000,
            "words": [
                {"text": "Hi", "begin_time": 100, "end_time": 300},
                {"text": "😀", "begin_time": 300, "end_time": 450},
                {"text": "Bye", "begin_time": 600, "end_time": 900},
            ],
        },
        "qwen-audio-3.1-asr-flash-filetrans",
        1000,
    )
    assert status == "available"
    return text, data


def test_a_single_turn_keeps_original_text_and_times_without_word_timing():
    timeline = service.Timeline([{"start_ms": 0, "end_ms": 1000, "speaker": "0"}], 1000)
    (row,) = service.align("Original text.", 50, 900, timeline)
    assert (row.text, row.speaker, row.start_ms, row.end_ms) == (
        "Original text.",
        "0",
        50,
        900,
    )


def test_word_splits_preserve_every_character_utf16_offsets_and_source_times():
    text, data = evidence()
    rows = service.align(text, 0, 1000, service.Timeline(turns(), 1000), alignment=data)
    assert [row.text for row in rows] == ["Hi 😀.  ", "Bye!"]
    assert "".join(row.text for row in rows) == text
    assert [row.speaker for row in rows] == ["0", "1"]
    assert [(row.start_ms, row.end_ms) for row in rows] == [(100, 450), (600, 900)]
    assert rows[0].end_offset == rows[1].start_offset == 8
    assert rows[1].alignment["tokens"][0]["start_offset"] == 0
    assert rows[1].alignment["text_sha256"] == word_alignment.text_hash("Bye!")


@pytest.mark.parametrize("corrected", [False, True])
def test_without_usable_original_timing_cross_speaker_sentences_stay_ambiguous(
    corrected,
):
    text, data = evidence()
    (row,) = service.align(
        text,
        0,
        1000,
        service.Timeline(turns(), 1000),
        alignment=data if corrected else None,
        corrected=corrected,
    )
    assert (
        row.text == text
        and row.speaker is None
        and row.reason == "word_timing_unavailable"
    )


def test_a_word_crossing_a_turn_boundary_is_not_assigned_by_majority_overlap():
    text, data = evidence()
    data["tokens"][1]["end_ms"] = 550
    rows = service.align(text, 0, 1000, service.Timeline(turns(), 1000), alignment=data)
    assert [row.speaker for row in rows] == ["0", None, "1"]
    assert rows[1].reason == "word_boundary_ambiguous"
    assert "".join(row.text for row in rows) == text


def test_overlap_unknown_and_source_gaps_never_become_a_person():
    text, data = evidence()
    timeline = service.Timeline(
        [
            {"start_ms": 0, "end_ms": 1000, "speaker": "0"},
            {"start_ms": 300, "end_ms": 450, "speaker": "1"},
        ],
        1000,
    )
    rows = service.align(text, 0, 1000, timeline, alignment=data)
    assert [row.speaker for row in rows] == ["0", None, "0"]
    assert rows[1].reason == "overlap_or_unknown"
    timeline = service.Timeline(
        [{"start_ms": 0, "end_ms": 1000, "speaker": "0"}],
        1000,
        source_ranges=[(0, 450), (600, 1000)],
    )
    rows = service.align(text, 0, 1000, timeline, alignment=data)
    assert len(rows) == 2 and all(row.speaker == "0" for row in rows)
    assert rows[0].end_ms == 450 and rows[1].start_ms == 600


@pytest.mark.parametrize(
    "field,value",
    [
        ("text_sha256", "0" * 64),
        ("version", 2),
        ("time_basis", "provider_clock"),
        ("offset_unit", "codepoints"),
        ("tokens", []),
        ("provider", ""),
    ],
)
def test_bad_word_metadata_cannot_enable_a_split(field, value):
    text, data = evidence()
    data[field] = value
    (row,) = service.align(
        text, 0, 1000, service.Timeline(turns(), 1000), alignment=data
    )
    assert row.speaker is None and row.text == text


@pytest.mark.parametrize(
    "field,value",
    [
        ("start_offset", 4),
        ("end_offset", 4),
        ("start_ms", True),
        ("end_ms", 1001),
        ("start_ms", 250),
        ("end_offset", 12),
    ],
)
def test_bad_tokens_surrogate_boundaries_and_overlaps_fail_closed(field, value):
    text, original = evidence()
    data = deepcopy(original)
    data["tokens"][1][field] = value
    (row,) = service.align(
        text, 0, 1000, service.Timeline(turns(), 1000), alignment=data
    )
    assert row.speaker is None and row.text == text


@pytest.mark.parametrize("start,end", [(0, None), (1000, 1000), (0, 1001)])
def test_missing_or_outside_original_time_never_gets_a_speaker(start, end):
    (row,) = service.align("Original", start, end, service.Timeline(turns(), 1000))
    assert row.speaker is None and row.reason == "time_unavailable"


@pytest.mark.parametrize(
    "change",
    [
        {"start_ms": -1},
        {"start_ms": True},
        {"end_ms": 1001},
        {"end_ms": 0},
        {"speaker": "Name"},
        {"speaker": 0},
        {"speaker": "01"},
    ],
)
def test_invalid_provider_turns_are_rejected(change):
    with pytest.raises(ValueError):
        service.Timeline([{**turns()[0], **change}], 1000)


def test_fifty_one_speakers_and_oversize_turn_ledgers_are_rejected():
    with pytest.raises(ValueError, match="speakers_exceeded"):
        service.Timeline(
            [{"start_ms": 0, "end_ms": 1000, "speaker": str(i)} for i in range(51)],
            1000,
        )
    with pytest.raises(ValueError):
        service.Timeline([turns()[0]] * 20001, 1000)
