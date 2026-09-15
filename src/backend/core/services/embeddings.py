"""Qwen3 text embeddings through Alibaba Cloud Bailian OpenAI-compatible API."""

from __future__ import annotations

import json
import math
import logging
import urllib.error
import urllib.request
from typing import Iterable, Optional

from django.conf import settings

logger = logging.getLogger(__name__)


_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


class EmbeddingUnavailable(RuntimeError):
    """Raised when the embedding client cannot be constructed."""


class EmbeddingClient:
    """Text-only vector client; never reuses embeddings from another model."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 60.0,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._endpoint = f"{base_url.rstrip('/')}/embeddings"
        self._timeout = timeout

    @classmethod
    def from_settings(cls) -> "EmbeddingClient":
        api_key = getattr(settings, "DASHSCOPE_API_KEY", None) or ""
        model = getattr(settings, "QWEN_EMBEDDING_MODEL", None) or "text-embedding-v4"
        base_url = (
            getattr(settings, "MEETING_SUMMARY_BASE_URL", None) or _DEFAULT_BASE_URL
        )
        if not api_key or not model:
            raise EmbeddingUnavailable(
                "DASHSCOPE_API_KEY / QWEN_EMBEDDING_MODEL not configured. "
                "See helm values for backend.envVars."
            )
        return cls(api_key=api_key, model=model, base_url=base_url)

    @property
    def model(self) -> str:
        return self._model

    # ------------------------------------------------------------------
    # Public API (unchanged contract since Sprint 2.4 Step 1)
    # ------------------------------------------------------------------

    def embed(self, text: str) -> list[float]:
        if not text:
            raise ValueError("text must not be empty")
        return self._embed_one(text)

    def batch_embed(self, texts: Iterable[str]) -> list[list[float]]:
        """Embed texts in input order with bounded per-request payloads."""
        items = list(texts)
        if not items:
            return []
        if any(not t for t in items):
            raise ValueError("batch_embed received an empty string")

        results: list[list[float]] = []
        for t in items:
            results.append(self._embed_one(t))
        return results

    def embed_query(self, question: str) -> Optional[list[float]]:
        question = (question or "").strip()
        if not question:
            return None
        return self._embed_one(question)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _embed_one(self, text: str) -> list[float]:
        payload = json.dumps(
            {
                "model": self._model,
                "input": [text],
                "encoding_format": "float",
                "dimensions": 1024,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            self._endpoint,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            data=payload,
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                body = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(
                f"Qwen embedding HTTP {e.code}"
            ) from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Qwen embedding network error: {e.reason}") from e

        data = body.get("data")
        if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
            raise RuntimeError("Unexpected Qwen embedding response shape")
        embedding = data[0].get("embedding")
        if not isinstance(embedding, list) or not embedding:
            raise RuntimeError("Qwen embedding response missing vector")
        if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in embedding):
            raise RuntimeError("Qwen embedding response contains invalid values")
        return embedding


__all__ = ("EmbeddingClient", "EmbeddingUnavailable")
