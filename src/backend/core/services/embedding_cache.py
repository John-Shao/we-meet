"""Redis-backed cache for query-side embeddings (Sprint 2.6).

Caches the embedding of a user *question*, keyed by ``(model, normalised
question)``, so repeated or shared questions skip the Ark embedding
round-trip (~500 ms + token cost). Cross-user shared meetings make the
same question recur often, which is exactly where this pays off.

Indexing-side embeddings (the Celery ``embed_meeting_transcripts`` task)
deliberately do **not** use this — chunk vectors are persisted in the DB
and never re-embedded on read.

Cache faults never propagate: a Redis hiccup degrades to a live embed
(slower), never a failed request. See ``docs/features/hybrid_retrieval.md`` §3.1.
"""

from __future__ import annotations

import hashlib
import logging
import re

from django.conf import settings
from django.core.cache import cache

from core.services.embeddings import EmbeddingClient

logger = logging.getLogger(__name__)

# 7 days. Question→vector is deterministic per model; the key carries the
# model id so an endpoint swap busts every entry without a manual flush.
_DEFAULT_TTL = 60 * 60 * 24 * 7
_WHITESPACE_RE = re.compile(r"\s+")


def _normalise(question: str) -> str:
    """Collapse whitespace + casefold so trivially different spellings of
    the same question share a cache slot (e.g. ``"Hello  World"`` and
    ``" hello world "``). Chinese has no case, but this still helps mixed
    CN/EN queries and stray spacing."""
    return _WHITESPACE_RE.sub(" ", question.strip()).casefold()


def _cache_key(model: str, question: str) -> str:
    digest = hashlib.sha256(
        f"{model}\x00{_normalise(question)}".encode("utf-8")
    ).hexdigest()
    return f"emb:q:{model}:{digest}"


def cached_embed(client: EmbeddingClient, question: str) -> list[float]:
    """Embed ``question``, served from Redis when previously seen.

    Falls back to a direct ``client.embed`` on any cache error so a Redis
    outage degrades to "slower", never "broken".
    """
    key = _cache_key(client.model, question)
    ttl = getattr(settings, "RAG_QUERY_EMBED_CACHE_TTL", _DEFAULT_TTL)

    try:
        hit = cache.get(key)
    except Exception:  # noqa: BLE001 — cache must never break the request
        logger.warning("embedding cache read failed", exc_info=True)
        hit = None
    if isinstance(hit, list) and hit:
        return hit

    vec = client.embed(question)

    try:
        cache.set(key, vec, ttl)
    except Exception:  # noqa: BLE001 — see above
        logger.warning("embedding cache write failed", exc_info=True)
    return vec


__all__ = ("cached_embed",)
