"""Realistic provider shapes and fail-closed text/timing contracts."""

from types import SimpleNamespace

import pytest

from core.services.word_alignment import for_reader, from_sentence


def sentence(text, words):
    return {"text": text, "begin_time": 0, "end_time": 2000, "words": words}


def word(text, start, end):
    return {"text": text, "begin_time": start, "end_time": end}


def test_repeated_words_mixed_language_and_utf16():
    data, status = from_sentence(
        sentence(
            "我们，🙂 Hello，我们。",
            [
                word("我们", 0, 200),
                word("🙂", 300, 500),
                word(" Hello", 500, 800),
                word("我们。", 900, 1200),
            ],
        ),
        "test",
    )
    assert status == "available"
    assert [(t["start_offset"], t["end_offset"]) for t in data["tokens"]] == [
        (0, 2),
        (3, 5),
        (6, 11),
        (12, 14),
    ]
    assert data["tokens"][-1]["start_ms"] == 900


@pytest.mark.parametrize(
    "text,words",
    [
        ("我们我们", [word("我们", 0, 100)]),
        ("hello", [word("hello", 100, 100)]),
        ("hello", [word("hello", True, 100)]),
        ("hello world", [word("hello", 0, 200), word("world", 100, 300)]),
        ("hello", [word("hello", 0, 2001)]),
        ("hello", [word("other", 0, 100)]),
        ("e\u0301", [word("e", 0, 100), word("\u0301", 100, 200)]),
        ("👩‍💻", [word("👩", 0, 100), word("‍💻", 100, 200)]),
        ("hello", {"text": "hello"}),
        ("hello", [None]),
    ],
)
def test_invalid_words_do_not_guess_alignment(text, words):
    assert from_sentence(sentence(text, words), "test") == (None, "invalid")


def test_absent_words_and_correction_fallback():
    assert from_sentence(sentence("hello", None), "test") == (None, "missing")
    assert from_sentence(sentence("hello", [word("hello", 0, 1000)]), "test", 500) == (
        None,
        "invalid",
    )
    data, status = from_sentence(sentence("hello", [word("hello", 0, 1000)]), "test")
    row = SimpleNamespace(
        text="hello",
        corrected_text="hello",
        word_alignment=data,
        alignment_status=status,
        alignment_revision=1,
    )
    assert for_reader(row)["tokens"] == data["tokens"]
    assert "provider" not in for_reader(row)
    row.corrected_text = "Hello"
    assert for_reader(row) == {"status": "text_changed"}
    row.corrected_text = "hello"
    assert for_reader(row)["status"] == "available"
    row.word_alignment["text_sha256"] = "wrong"
    assert for_reader(row) == {"status": "invalid"}
