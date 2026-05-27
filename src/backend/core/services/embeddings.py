"""Text embedding via Volcengine Ark (OpenAI-compatible /v1/embeddings).

Sprint 2.4 — companion to ``llm_client.py``: same auth / base URL /
``openai`` SDK, just hits ``embeddings.create`` instead of
``chat.completions.create``. Doubao text-embedding endpoints expose an
``ep-...`` ID via ``DOUBAO_EMBEDDING_ENDPOINT``; we don't hard-code the
model name so the Ark console can re-point to a newer embedding model
without a backend redeploy.

This module is intentionally synchronous: callers are Celery tasks and
management commands, neither benefits from an async client.
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

from django.conf import settings

logger = logging.getLogger(__name__)


_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"


class EmbeddingUnavailable(RuntimeError):
    """Raised when the embedding client cannot be constructed."""


class EmbeddingClient:
    """Thin wrapper around ``openai.OpenAI.embeddings`` against Ark.

    Mirrors ``LLMClient`` so callers can swap them mentally. Use
    :py:meth:`batch_embed` for any list of strings; the Ark embedding
    endpoint accepts up to 32 inputs per call, so we chunk by 32 here
    so callers don't have to think about it.
    """

    # Doubao text embedding endpoints accept up to 32 inputs per call.
    _BATCH_SIZE = 32

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 60.0,
    ) -> None:
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
        self._model = model

    @classmethod
    def from_settings(cls) -> "EmbeddingClient":
        api_key = getattr(settings, "ARK_API_KEY", None) or ""
        model = getattr(settings, "DOUBAO_EMBEDDING_ENDPOINT", None) or ""
        base_url = (
            getattr(settings, "ARK_BASE_URL", None) or _DEFAULT_BASE_URL
        )
        if not api_key or not model:
            raise EmbeddingUnavailable(
                "ARK_API_KEY / DOUBAO_EMBEDDING_ENDPOINT not configured. "
                "See helm values for backend.envVars."
            )
        return cls(api_key=api_key, model=model, base_url=base_url)

    @property
    def model(self) -> str:
        return self._model

    def embed(self, text: str) -> list[float]:
        """Single-string convenience wrapper around :py:meth:`batch_embed`."""
        if not text:
            raise ValueError("text must not be empty")
        return self.batch_embed([text])[0]

    def batch_embed(self, texts: Iterable[str]) -> list[list[float]]:
        """Embed ``texts``; preserves order and returns one vector per input.

        Chunks the input list into Ark-friendly batches transparently.
        Empty strings are rejected before the request to avoid 400s from
        Ark; callers should filter beforehand if they need to keep
        positions stable.
        """
        items = list(texts)
        if not items:
            return []
        if any(not t for t in items):
            raise ValueError("batch_embed received an empty string")

        results: list[list[float]] = []
        for start in range(0, len(items), self._BATCH_SIZE):
            batch = items[start : start + self._BATCH_SIZE]
            resp = self._client.embeddings.create(model=self._model, input=batch)
            # Ark returns data in input order — verify by index to catch
            # SDK upgrades that change ordering semantics.
            ordered = sorted(resp.data, key=lambda d: d.index)
            results.extend(d.embedding for d in ordered)

        if len(results) != len(items):
            raise RuntimeError(
                f"Ark returned {len(results)} vectors for {len(items)} inputs"
            )
        return results

    def embed_query(self, question: str) -> Optional[list[float]]:
        """Convenience for the retrieval side: tolerate empty input
        (caller validated; returns None to short-circuit search)."""
        question = (question or "").strip()
        if not question:
            return None
        return self.embed(question)


__all__ = ("EmbeddingClient", "EmbeddingUnavailable")
