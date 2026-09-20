"""Literal ASR hints shared by saved vocabularies and per-upload snapshots."""


def parse_hotwords(value):
    """Trim lines and de-duplicate in order without case folding or truncation."""
    words = list(
        dict.fromkeys(word.strip() for word in value.splitlines() if word.strip())
    )
    if len(words) > 100 or any(len(word) > 40 for word in words):
        raise ValueError("Use at most 100 hotwords, each up to 40 characters.")
    return words
