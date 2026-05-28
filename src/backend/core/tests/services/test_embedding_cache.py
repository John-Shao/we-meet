"""Tests for the query-embedding Redis cache (Sprint 2.6)."""
# pylint: disable=W0621

from unittest import mock

from django.core.cache import cache
from django.test import override_settings

from core.services.embedding_cache import cached_embed

# Isolate from the real Redis cache so these run anywhere and don't collide.
LOCMEM = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "emb-cache-test",
    }
}


class _FakeClient:
    """Stand-in for EmbeddingClient that counts embed() calls."""

    def __init__(self, vec, model="ep-test"):
        self.model = model
        self._vec = vec
        self.calls = 0

    def embed(self, text):  # noqa: ARG002 — text unused, we return a fixed vec
        self.calls += 1
        return list(self._vec)


@override_settings(CACHES=LOCMEM)
def test_cache_miss_then_hit():
    cache.clear()
    client = _FakeClient([0.1, 0.2, 0.3])

    first = cached_embed(client, "上班时间有变化吗")
    assert first == [0.1, 0.2, 0.3]
    assert client.calls == 1

    second = cached_embed(client, "上班时间有变化吗")
    assert second == [0.1, 0.2, 0.3]
    assert client.calls == 1  # served from cache, no second embed


@override_settings(CACHES=LOCMEM)
def test_normalisation_merges_keys():
    cache.clear()
    client = _FakeClient([1.0])

    cached_embed(client, "Hello World")
    cached_embed(client, "  hello   world ")
    # casefold + whitespace collapse → identical key → single embed.
    assert client.calls == 1


@override_settings(CACHES=LOCMEM)
def test_model_change_busts_key():
    cache.clear()
    c_a = _FakeClient([1.0], model="ep-a")
    c_b = _FakeClient([2.0], model="ep-b")

    assert cached_embed(c_a, "同一个问题") == [1.0]
    # Same question, different model id → different key → fresh embed.
    assert cached_embed(c_b, "同一个问题") == [2.0]
    assert c_b.calls == 1


def test_cache_failure_falls_back_to_live_embed():
    """A Redis outage must degrade to a live embed, never raise."""
    client = _FakeClient([0.5])
    with mock.patch("core.services.embedding_cache.cache") as m:
        m.get.side_effect = RuntimeError("redis down")
        m.set.side_effect = RuntimeError("redis down")
        out = cached_embed(client, "随便问问")

    assert out == [0.5]
    assert client.calls == 1
