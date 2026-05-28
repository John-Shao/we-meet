"""Hybrid retrieval for cross-meeting RAG (Sprint 2.6).

Two retrieval legs over the same in-memory candidate set:

* ``vector_rank`` — cosine similarity on the stored embeddings (the
  Sprint 2.4 dense path, moved here from ``PersonalAIService._rank``).
* ``bm25_rank`` — lexical BM25 over jieba-tokenised text, catching exact
  terms (names, dates, jargon) that dense vectors blur.

``reciprocal_rank_fusion`` merges the rankings with RRF, which needs no
score-scale alignment between legs. See
``docs/features/hybrid_retrieval.md`` §3.2.
"""

from __future__ import annotations

import logging

import jieba
import numpy as np
from rank_bm25 import BM25Okapi

logger = logging.getLogger(__name__)

# Each leg contributes at most this many candidates to the fusion. Keeps
# RRF cheap and focuses it on each leg's genuinely strong hits.
DEFAULT_CANDIDATE_N = 50
# RRF dampening constant. 60 is the value from the original RRF paper —
# large enough that rank gaps past the top few don't dominate the fusion.
RRF_K = 60


def vector_rank(q_vec, chunks, *, top_n: int = DEFAULT_CANDIDATE_N):
    """Cosine similarity between ``q_vec`` and each chunk's embedding.

    Skips chunks whose stored embedding is empty / wrong-shaped — the rest
    still rank instead of failing the whole query. Returns at most
    ``top_n`` ``(chunk, score)`` pairs, highest score first.
    """
    q = np.asarray(q_vec, dtype=np.float32)
    target_dim = q.shape[0]
    keep = []
    rows = []
    for c in chunks:
        vec = c.embedding
        if not vec or len(vec) != target_dim:
            continue
        keep.append(c)
        rows.append(np.asarray(vec, dtype=np.float32))
    if not keep:
        return []

    matrix = np.vstack(rows)
    q_norm = q / (np.linalg.norm(q) + 1e-12)
    m_normed = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-12)
    scores = m_normed @ q_norm
    order = np.argsort(-scores)[:top_n]
    return [(keep[i], float(scores[i])) for i in order]


def _tokenise(text: str) -> list[str]:
    # search-mode segmentation yields finer sub-tokens (better recall for
    # compound terms); lowercase so EN tokens match regardless of case.
    return [t for t in jieba.lcut_for_search((text or "").lower()) if t.strip()]


def bm25_rank(question: str, chunks, *, top_n: int = DEFAULT_CANDIDATE_N):
    """BM25 lexical ranking over the chunk texts.

    Builds the BM25 index from the in-memory candidate set on each call —
    fine at the current <10K-chunk scale. Returns at most ``top_n``
    ``(chunk, score)`` pairs with score > 0, highest first. Empty query
    tokens or empty corpus → empty result.
    """
    chunk_list = list(chunks)
    if not chunk_list:
        return []
    q_tokens = _tokenise(question)
    if not q_tokens:
        return []

    corpus = [_tokenise(c.text) for c in chunk_list]
    if not any(corpus):  # all docs tokenised to nothing → BM25 undefined
        return []

    bm25 = BM25Okapi(corpus)
    scores = bm25.get_scores(q_tokens)
    order = np.argsort(-scores)[:top_n]
    return [
        (chunk_list[i], float(scores[i])) for i in order if scores[i] > 0
    ]


def reciprocal_rank_fusion(*ranked_lists, k: int = RRF_K, top_k: int = 12):
    """Fuse several ``[(chunk, score)]`` rankings into one via RRF.

    RRF score for a chunk = Σ over legs of ``1 / (k + rank)`` (rank is
    1-based, counted only in legs where the chunk appears). Dedupes by
    ``chunk.id``; equal fused scores keep first-seen order. Returns the
    top_k ``(chunk, fused_score)`` pairs.
    """
    fused: dict = {}
    chunk_by_id: dict = {}
    for ranked in ranked_lists:
        for rank, (chunk, _score) in enumerate(ranked, start=1):
            cid = chunk.id
            chunk_by_id.setdefault(cid, chunk)
            fused[cid] = fused.get(cid, 0.0) + 1.0 / (k + rank)
    ordered = sorted(fused.items(), key=lambda kv: -kv[1])
    return [(chunk_by_id[cid], score) for cid, score in ordered[:top_k]]


__all__ = (
    "vector_rank",
    "bm25_rank",
    "reciprocal_rank_fusion",
    "DEFAULT_CANDIDATE_N",
    "RRF_K",
)
