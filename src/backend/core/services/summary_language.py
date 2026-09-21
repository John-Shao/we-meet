"""Use unanimous source-language metadata without guessing from a user's locale."""

LANGUAGES = {
    "zh": "Chinese (preserve the source's simplified or traditional script)",
    "en": "English",
    "fr": "French",
    "de": "German",
    "nl": "Dutch",
    "ja": "Japanese",
    "ko": "Korean",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ar": "Arabic",
}


def language_instruction(segments):
    """Unknown/mixed metadata must not let a small tagged fragment set the language."""
    languages = set()
    for row in segments:
        if not row.get("text", "").strip():
            continue
        raw = row.get("language")
        if not isinstance(raw, str):
            return ""
        key = raw.strip().lower().replace("_", "-").split("-")[0]
        if key not in LANGUAGES:
            return ""
        languages.add(key)
    if len(languages) != 1:
        return ""
    language = LANGUAGES[next(iter(languages))]
    return (
        f"Write all generated prose in {language}. "
        "The output language comes from the source, not the English schema or system prompt. "
        "Preserve proper names, quoted terms and exact source references. "
    )
