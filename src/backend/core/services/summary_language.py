"""Honor explicit output language or follow source text, never the UI locale."""

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


def language_instruction(segments, output_language="auto"):
    """Unknown/mixed metadata must not let a small tagged fragment set the language."""
    if output_language != "auto":
        language = LANGUAGES[output_language]
        return (
            f"Write all generated prose in {language}, as explicitly selected by the user. "
            "Apply this language to the synopsis, every topic title and every topic body. "
            "Preserve proper names, quoted terms and exact source references. "
        )
    fallback = (
        "Write all generated prose in the primary language of the original transcript, "
        "including the synopsis, every topic title and every topic body. "
        "Infer the primary language from the full original text when language metadata "
        "is missing or mixed. Preserve its simplified or traditional script. "
        "Do not translate into English because the schema or these instructions are English. "
        "For multilingual transcripts use the predominant language, retaining necessary original terms. "
        "Preserve proper names, quoted terms and exact source references. "
    )
    languages = set()
    for row in segments:
        if not row.get("text", "").strip():
            continue
        raw = row.get("language")
        if not isinstance(raw, str):
            return fallback
        key = raw.strip().lower().replace("_", "-").split("-")[0]
        if key not in LANGUAGES:
            return fallback
        languages.add(key)
    if len(languages) != 1:
        return fallback
    language = LANGUAGES[next(iter(languages))]
    return (
        f"Write all generated prose in {language}. "
        "The output language comes from the source, not the English schema or system prompt. "
        "Preserve proper names, quoted terms and exact source references. "
    )
