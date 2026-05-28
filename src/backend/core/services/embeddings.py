"""Text embedding via Volcengine Ark multimodal embeddings API.

Sprint 2.4 — originally targeted ``doubao-embedding-large`` via the
OpenAI-compatible ``/v1/embeddings`` route, but that and the standard
``doubao-embedding`` are being deprecated upstream. We now point at
``doubao-embedding-vision`` which speaks Ark's native
``/api/v3/embeddings/multimodal`` shape:

* Request: ``{model, input: [{type: "text", text: "..."}]}``
* Response: ``{data: {embedding: [...]}, usage: {...}}`` (single result)
* No batching — each call returns exactly one embedding.

Because the multimodal API isn't OpenAI-compatible, we bypass the
``openai`` SDK and hit Ark with ``urllib`` directly (zero new deps, no
async needs — callers are Celery tasks / management commands). The
public interface is preserved: callers still see
``batch_embed(list[str]) -> list[list[float]]`` and the existing
``embed_meeting_transcripts`` task / ``PersonalAIService`` are untouched.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Iterable, Optional

from django.conf import settings

logger = logging.getLogger(__name__)


_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"


class EmbeddingUnavailable(RuntimeError):
    """Raised when the embedding client cannot be constructed."""


class EmbeddingClient:
    """Doubao multimodal embedding client (Ark native API).

    Despite the "multimodal" name we feed it text-only inputs in
    Sprint 2.4. The vision-capable model is the only Ark embedding
    family that isn't slated for deprecation; we'll layer in image
    embedding (Sprint 2.6+) by extending the per-item ``input`` payload.
    """

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
        self._endpoint = f"{base_url.rstrip('/')}/embeddings/multimodal"
        self._timeout = timeout

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

    # ------------------------------------------------------------------
    # Public API (unchanged contract since Sprint 2.4 Step 1)
    # ------------------------------------------------------------------

    def embed(self, text: str) -> list[float]:
        if not text:
            raise ValueError("text must not be empty")
        return self._embed_one(text)

    def batch_embed(self, texts: Iterable[str]) -> list[list[float]]:
        """Embed each text in order. Caller's input order is preserved.

        Ark multimodal embeddings is one-input-per-call, so this is a
        plain sequential loop — no SDK-side batching to lean on. For
        backfill of ~5K chunks @ ~500 ms each that's ~40 min sequential;
        acceptable for the current scale and easier to reason about than
        a thread pool. If throughput becomes a bottleneck, this is the
        single spot to add ``concurrent.futures``.
        """
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
                "input": [{"type": "text", "text": text}],
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
            detail = e.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(
                f"Ark embedding HTTP {e.code}: {detail}"
            ) from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Ark embedding network error: {e.reason}") from e

        # Multimodal response shape: data is a *dict*, not a list, and
        # carries one embedding per call. See module docstring.
        data = body.get("data")
        if not isinstance(data, dict):
            raise RuntimeError(
                f"Unexpected Ark embedding response shape: keys={list(body)}"
            )
        embedding = data.get("embedding")
        if not isinstance(embedding, list) or not embedding:
            raise RuntimeError("Ark embedding response missing 'embedding' list")
        return embedding


__all__ = ("EmbeddingClient", "EmbeddingUnavailable")
