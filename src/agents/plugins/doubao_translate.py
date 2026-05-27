"""Doubao Pro LLM translation client for the transcriber agent.

Lightweight wrapper around the official Volcengine Ark SDK
(``volcenginesdkarkruntime``) that translates text from one language into
one or more target languages. Used by ``multi_user_transcriber`` to add
multi-language captions in real-time after each FINAL transcript.

Failures are logged but never raised — losing one translation must not
crash the transcription session.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Iterable

from volcenginesdkarkruntime import AsyncArk

logger = logging.getLogger("doubao-translate")

# Map ISO codes we use across we-meet to natural-language names for the
# translation prompt. The we-meet User.language values are zh-cn / en-us /
# fr-fr / nl-nl / de-de (see backend settings.LANGUAGES); STT may also
# emit short ISO codes like "zh" / "en", so accept both.
_LANG_NAMES = {
    "zh-cn": "Simplified Chinese",
    "zh": "Simplified Chinese",
    "en-us": "English",
    "en": "English",
    "fr-fr": "French",
    "fr": "French",
    "de-de": "German",
    "de": "German",
    "nl-nl": "Dutch",
    "nl": "Dutch",
    "ja-jp": "Japanese",
    "ja": "Japanese",
}


def _lang_label(iso: str) -> str:
    return _LANG_NAMES.get(iso.lower(), iso)


def _norm(iso: str) -> str:
    return (iso or "").lower().strip()


def _matches(src: str, tgt: str) -> bool:
    """``zh`` and ``zh-cn`` count as the same language."""
    if src == tgt:
        return True
    return src.split("-", 1)[0] == tgt.split("-", 1)[0]


class DoubaoTranslator:
    """Async translator backed by Doubao Pro via Volcengine Ark."""

    def __init__(
        self,
        *,
        api_key: str,
        llm_endpoint: str,
        base_url: str = "https://ark.cn-beijing.volces.com/api/v3",
        timeout: float = 8.0,
    ) -> None:
        self._client = AsyncArk(api_key=api_key, base_url=base_url, timeout=timeout)
        self._llm_endpoint = llm_endpoint

    @classmethod
    def from_env(cls) -> "DoubaoTranslator | None":
        """Construct from ``ARK_API_KEY`` + ``DOUBAO_LLM_ENDPOINT``.

        Returns ``None`` if either is missing so the caller can skip the
        translation step gracefully.
        """
        api_key = os.getenv("ARK_API_KEY", "")
        endpoint = os.getenv("DOUBAO_LLM_ENDPOINT", "")
        if not api_key or not endpoint:
            return None
        return cls(api_key=api_key, llm_endpoint=endpoint)

    async def translate(
        self,
        text: str,
        *,
        source_lang: str,
        target_lang: str,
    ) -> str:
        """Translate *text* into *target_lang*. Returns "" on failure."""
        src = _norm(source_lang)
        tgt = _norm(target_lang)
        if not text.strip() or not tgt:
            return ""
        if src and _matches(src, tgt):
            return text  # no-op when source == target

        # Strong "translate verbatim" prompt: prevents the LLM from
        # "helpfully" correcting typos / commenting on issues / explaining
        # the input. Caption use case demands fidelity, not interpretation.
        # Also covers the "language tag is wrong" case (Doubao STT always
        # labels output as zh, even for English content) by short-circuiting
        # to the original text when source and target are equivalent.
        prompt = (
            f"Translate the following text from "
            f"{_lang_label(src or 'auto-detected')} to {_lang_label(tgt)}. "
            "Reply with ONLY the translated text — no explanations, no "
            "quotes, no language prefix. Do NOT correct, comment on, or "
            "explain the input; translate it verbatim even if it contains "
            "typos, fragments, or grammatical issues. If the input is "
            f"already entirely in {_lang_label(tgt)}, reply with the "
            f"original text unchanged.\n\n{text}"
        )
        try:
            resp = await self._client.chat.completions.create(
                model=self._llm_endpoint,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
            )
            return resp.choices[0].message.content.strip()
        except Exception:
            logger.exception(
                "translation failed (%s -> %s): %r", src, tgt, text[:80]
            )
            return ""

    async def translate_many(
        self,
        text: str,
        *,
        source_lang: str,
        target_langs: Iterable[str],
    ) -> dict[str, str]:
        """Translate to multiple target languages concurrently.

        Returns ``{target_lang: translation}`` for languages that produced
        a non-empty result. Same-language targets are filtered out, and
        translations that failed (empty string) are omitted from the dict.
        """
        src = _norm(source_lang)
        targets = [t for t in (_norm(t) for t in target_langs) if t]
        targets = [t for t in targets if not (src and _matches(src, t))]
        if not targets:
            return {}

        results = await asyncio.gather(
            *(self.translate(text, source_lang=src, target_lang=t) for t in targets),
            return_exceptions=False,
        )
        return {t: r for t, r in zip(targets, results) if r}
