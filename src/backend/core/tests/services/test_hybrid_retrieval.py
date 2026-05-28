"""Tests for hybrid retrieval — vector / BM25 / RRF (Sprint 2.6)."""
# pylint: disable=W0621

from core.services.hybrid_retrieval import (
    bm25_rank,
    reciprocal_rank_fusion,
    vector_rank,
)


class FakeChunk:
    """Minimal stand-in for TranscriptChunk (id / text / embedding)."""

    def __init__(self, cid, text="", embedding=None):
        self.id = cid
        self.text = text
        self.embedding = embedding if embedding is not None else []


# ---------------------------------------------------------------- vector

def test_vector_rank_orders_by_cosine_and_skips_bad_embeddings():
    a = FakeChunk("a", embedding=[1.0, 0.0, 0.0])  # cosine 1.0 vs query
    b = FakeChunk("b", embedding=[0.0, 1.0, 0.0])  # cosine 0.0
    bad = FakeChunk("bad", embedding=[])            # skipped
    wrong = FakeChunk("wrong", embedding=[1.0, 2.0])  # wrong dim → skipped

    ranked = vector_rank([1.0, 0.0, 0.0], [a, b, bad, wrong])

    ids = [c.id for c, _ in ranked]
    assert ids == ["a", "b"]
    assert ranked[0][1] > ranked[1][1]


def test_vector_rank_empty_when_no_usable_embeddings():
    assert vector_rank([1.0, 0.0], [FakeChunk("x", embedding=[])]) == []
    assert vector_rank([1.0, 0.0], []) == []


# ------------------------------------------------------------------ bm25

def test_bm25_surfaces_exact_term_match():
    """The value-add: a chunk with the queried rare term ranks, even
    against chunks about unrelated topics."""
    hit = FakeChunk("hit", text="赵六说这个季度的预算是一百万元")
    miss1 = FakeChunk("m1", text="今天的天气非常好适合出去散步")
    miss2 = FakeChunk("m2", text="我们讨论了产品路线图和发布节奏")

    ranked = bm25_rank("赵六的预算", [miss1, hit, miss2])

    assert ranked, "expected at least one BM25 hit"
    assert ranked[0][0].id == "hit"


def test_bm25_empty_on_blank_query_or_corpus():
    assert bm25_rank("", [FakeChunk("a", text="内容")]) == []
    assert bm25_rank("问题", []) == []


# ------------------------------------------------------------------- rrf

def test_rrf_fuses_dedupes_and_truncates():
    a, b, c, d = (FakeChunk(x) for x in ("a", "b", "c", "d"))
    vec_ranked = [(a, 0.9), (b, 0.8), (c, 0.7)]
    bm25_ranked = [(c, 5.0), (a, 3.0), (d, 1.0)]

    fused = reciprocal_rank_fusion(vec_ranked, bm25_ranked, top_k=2)

    ids = [chunk.id for chunk, _ in fused]
    # a is rank-1 in vec + rank-2 in bm25 → highest combined; c close 2nd.
    assert ids == ["a", "c"]
    # dedup: a appears once despite being in both legs.
    assert len(ids) == len(set(ids))


def test_rrf_single_leg_and_empty():
    a = FakeChunk("a")
    assert reciprocal_rank_fusion([(a, 1.0)], top_k=5)[0][0].id == "a"
    assert reciprocal_rank_fusion() == []
    assert reciprocal_rank_fusion([], []) == []
