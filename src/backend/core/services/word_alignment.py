"""Optional, fail-closed word timing for immutable imported originals.

Times use the segment's source clock. Offsets use UTF-16, shared by JS/Kotlin.
Provider text is never substituted for the original reader's text.
"""

import hashlib
import json
import unicodedata

MAX_TOKENS = 10000
MAX_BYTES = 1024 * 1024


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _ignorable(text):
    return all(
        char.isspace() or unicodedata.category(char).startswith("P") for char in text
    )


def _boundary(text, index):
    if index in {0, len(text)}:
        return True
    before, after = text[index - 1], text[index]
    # Do not divide combining marks, emoji modifiers/ZWJ sequences or flag pairs.
    return not (
        unicodedata.category(after).startswith("M")
        or before == "\u200d"
        or after == "\u200d"
        or 0x1F3FB <= ord(after) <= 0x1F3FF
        or 0x1F1E6 <= ord(before) <= 0x1F1FF
        and 0x1F1E6 <= ord(after) <= 0x1F1FF
        or 0x1160 <= ord(after) <= 0x11FF
        or 0xE0020 <= ord(after) <= 0xE007F
    )


def _lexical(value):
    left, right = 0, len(value)
    while left < right and _ignorable(value[left]):
        left += 1
    while right > left and _ignorable(value[right - 1]):
        right -= 1
    return value[left:right]


def from_sentence(sentence, provider, media_end_ms=None):
    """Invalid enhancement data must not prevent publishing valid sentence text."""
    words = sentence.get("words")
    if words is None or words == []:
        return None, "missing"
    if not isinstance(words, list) or len(words) > MAX_TOKENS:
        return None, "invalid"
    text = sentence["text"]
    end_limit = sentence["end_time"]
    if type(media_end_ms) is int and media_end_ms > 0:
        end_limit = min(end_limit, media_end_ms)
    try:
        offsets = [0]
        for char in text:
            offsets.append(offsets[-1] + len(char.encode("utf-16-le")) // 2)
        tokens, cursor, previous_end = [], 0, sentence["begin_time"]
        for word in words:
            if not isinstance(word, dict):
                raise ValueError("invalid_word")
            value = word.get("text")
            start, end = word.get("begin_time"), word.get("end_time")
            if not isinstance(value, str) or not value:
                raise ValueError("invalid_word")
            # Some providers include leading blanks or punctuation in word.text.
            value = _lexical(value)
            if not value:
                continue
            found = text.find(value, cursor)
            stop = found + len(value)
            if (
                found < 0
                or not _ignorable(text[cursor:found])
                or not _boundary(text, found)
                or not _boundary(text, stop)
                or type(start) is not int
                or type(end) is not int
                or not previous_end <= start < end <= end_limit
            ):
                raise ValueError("invalid_word")
            tokens.append(
                {
                    "start_offset": offsets[found],
                    "end_offset": offsets[stop],
                    "start_ms": start,
                    "end_ms": end,
                }
            )
            cursor, previous_end = stop, end
        if not tokens or not _ignorable(text[cursor:]):
            return None, "invalid"
        alignment = {
            "version": 1,
            "provider": provider,
            "time_basis": "segment_source",
            "offset_unit": "utf16",
            "text_sha256": text_hash(text),
            "tokens": tokens,
        }
        if len(json.dumps(alignment).encode()) > MAX_BYTES:
            return None, "invalid"
        return alignment, "available"
    except (UnicodeError, TypeError, ValueError):
        return None, "invalid"


def for_reader(segment):
    """Never expose original offsets against a correction, including batch edits."""
    if segment.corrected_text != segment.text:
        return {"status": "text_changed"}
    data = segment.word_alignment
    if segment.alignment_status != "available" or not isinstance(data, dict):
        return {
            "status": segment.alignment_status
            if segment.alignment_status in {"missing", "invalid"}
            else "invalid"
        }
    if data.get("version") != 1 or data.get("text_sha256") != text_hash(segment.text):
        return {"status": "invalid"}
    return {
        **{key: value for key, value in data.items() if key != "provider"},
        "status": "available",
        "alignment_revision": segment.alignment_revision,
    }
