"""Conservative transcript checks for misrouted bilingual utterances."""

import unicodedata

MIN_LETTERS = 3


def _script(char):
    name = unicodedata.name(char, "")
    for script in (
        "HIRAGANA",
        "KATAKANA",
        "HANGUL",
        "THAI",
        "HEBREW",
        "CYRILLIC",
        "ARABIC",
    ):
        if script in name:
            return script
    if "CJK UNIFIED" in name or "CJK COMPATIBILITY IDEOGRAPH" in name:
        return "HAN"
    return "OTHER"


def transcript_language(text, pair):
    """Infer only distinctive scripts; shared Han/Latin scripts stay ambiguous."""
    letters = [_script(char) for char in text if char.isalpha()]
    if len(letters) < MIN_LETTERS:
        return None
    scripts = {
        "ja": {"HIRAGANA", "KATAKANA", "HAN"},
        "zh": {"HAN"},
        "ko": {"HANGUL", "HAN"},
        "th": {"THAI"},
        "he": {"HEBREW"},
        "ru": {"CYRILLIC"},
        "ar": {"ARABIC"},
        "fa": {"ARABIC"},
        "ur": {"ARABIC"},
    }
    matches = [
        language
        for language in pair
        if sum(script in scripts.get(language, set()) for script in letters)
        >= len(letters) * 0.8
    ]
    if len(matches) != 1:
        return None
    language = matches[0]
    # A few quoted kana/Hangul characters inside Chinese don't change its language.
    distinctive = {"ja": {"HIRAGANA", "KATAKANA"}, "ko": {"HANGUL"}}
    if language in distinctive and sum(
        script in distinctive[language] for script in letters
    ) < max(2, len(letters) * 0.5):
        return None
    return language


def source_language(event, selected, target):
    """Prefer explicit ASR evidence over the early audio routing decision."""
    pair = (selected, target)
    reported = event.get("language")
    if reported in pair:
        return reported
    return transcript_language(event["text"], pair) or selected


def same_words(first, second):
    """Compare lexical content without spacing, punctuation or width differences."""

    def normalize(text):
        return "".join(
            char
            for char in unicodedata.normalize("NFKC", text).casefold()
            if char.isalnum()
        )

    return bool(normalize(first)) and normalize(first) == normalize(second)
