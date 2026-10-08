"""Qwen3 text embeddings through Alibaba Cloud Bailian OpenAI-compatible API."""

from __future__ import annotations

import json
import logging
import math
import urllib.error
import urllib.request
from typing import Iterable, Optional

from django.conf import settings

from core.services import provider_http

logger = logging.getLogger(__name__)


_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
_BATCH_SIZE = 10
_DIMENSIONS = 1024


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

    def batch_embed(self, texts: Iterable[str], *, before_request=None) -> list[list[float]]:
        """Embed texts in input order with bounded per-request payloads."""
        items = list(texts)
        if not items:
            return []
        if any(not isinstance(t, str) or not t for t in items):
            raise ValueError("batch_embed received an empty string")

        results: list[list[float]] = []
        for offset in range(0, len(items), _BATCH_SIZE):
            if before_request is not None:
                before_request()
            results.extend(self._embed_batch(items[offset : offset + _BATCH_SIZE]))
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
        return self._embed_batch([text])[0]

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        payload = json.dumps(
            {
                "model": self._model,
                "input": texts,
                "encoding_format": "float",
                "dimensions": _DIMENSIONS,
            }
        ).encode("utf-8")
        # Request is a descriptor for the pooled HTTP adapter, not a URL opener.
        req = urllib.request.Request(  # noqa: S310
            self._endpoint,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            data=payload,
        )
        try:
            with provider_http.urlopen(req, timeout=self._timeout) as resp:
                body = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(
                f"Qwen embedding HTTP {e.code}"
            ) from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Qwen embedding network error: {e.reason}") from e

        data = body.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise RuntimeError("Unexpected Qwen embedding response shape")
        ordered = {}
        for row in data:
            if not isinstance(row, dict):
                raise RuntimeError("Unexpected Qwen embedding response shape")
            index, embedding = row.get("index"), row.get("embedding")
            if type(index) is not int or not 0 <= index < len(texts) or index in ordered:
                raise RuntimeError("Unexpected Qwen embedding response index")
            if not isinstance(embedding, list) or len(embedding) != _DIMENSIONS:
                raise RuntimeError("Qwen embedding response has invalid dimensions")
            if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in embedding):
                raise RuntimeError("Qwen embedding response contains invalid values")
            ordered[index] = embedding
        return [ordered[index] for index in range(len(texts))]


__all__ = ("EmbeddingClient", "EmbeddingUnavailable")
