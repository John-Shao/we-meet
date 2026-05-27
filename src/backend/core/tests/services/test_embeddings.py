"""Unit tests for ``EmbeddingClient`` (Sprint 2.4).

We don't talk to Ark in CI — these tests patch the ``openai.OpenAI``
client to verify batching, ordering preservation, and config validation.
"""
# pylint: disable=W0621

from types import SimpleNamespace
from unittest import mock

import pytest

from core.services.embeddings import (
    EmbeddingClient,
    EmbeddingUnavailable,
)


@pytest.fixture
def fake_openai(monkeypatch):
    """Patch ``openai.OpenAI`` to a MagicMock whose ``embeddings.create``
    returns a deterministic shape mirroring Ark's response.
    """
    instance = mock.MagicMock()

    def _fake_create(*, model, input):  # pylint: disable=redefined-builtin
        # Ark returns ``data: [{index, embedding}, ...]``. Use the input
        # position as the vector value so tests can assert ordering.
        return SimpleNamespace(
            data=[
                SimpleNamespace(index=i, embedding=[float(i)] * 4)
                for i in range(len(input))
            ]
        )

    instance.embeddings.create.side_effect = _fake_create

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            pass

        embeddings = instance.embeddings

    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    return instance


def test_from_settings_raises_when_misconfigured(settings):
    settings.ARK_API_KEY = ""
    settings.DOUBAO_EMBEDDING_ENDPOINT = ""
    with pytest.raises(EmbeddingUnavailable):
        EmbeddingClient.from_settings()


def test_batch_embed_preserves_input_order(fake_openai):
    client = EmbeddingClient(api_key="k", model="ep-test")
    vecs = client.batch_embed(["a", "b", "c"])
    assert vecs == [[0.0] * 4, [1.0] * 4, [2.0] * 4]


def test_batch_embed_chunks_at_32(fake_openai):
    """Ark caps embedding batches at 32 inputs; the client must split
    transparently so callers don't have to think about it."""
    client = EmbeddingClient(api_key="k", model="ep-test")
    texts = [f"t-{i}" for i in range(50)]
    vecs = client.batch_embed(texts)

    assert len(vecs) == 50
    # Two upstream calls: 32 + 18.
    assert fake_openai.embeddings.create.call_count == 2
    sizes = sorted(
        len(call.kwargs["input"])
        for call in fake_openai.embeddings.create.call_args_list
    )
    assert sizes == [18, 32]


def test_batch_embed_empty_input_skips_api_call(fake_openai):
    client = EmbeddingClient(api_key="k", model="ep-test")
    assert client.batch_embed([]) == []
    fake_openai.embeddings.create.assert_not_called()


def test_batch_embed_rejects_empty_string(fake_openai):
    client = EmbeddingClient(api_key="k", model="ep-test")
    with pytest.raises(ValueError):
        client.batch_embed(["ok", ""])
    # Should fail before any API call.
    fake_openai.embeddings.create.assert_not_called()


def test_embed_query_returns_none_for_blank(fake_openai):
    client = EmbeddingClient(api_key="k", model="ep-test")
    assert client.embed_query("   ") is None
    assert client.embed_query("") is None
    fake_openai.embeddings.create.assert_not_called()


def test_embed_query_returns_vector_for_real_question(fake_openai):
    client = EmbeddingClient(api_key="k", model="ep-test")
    vec = client.embed_query("结论是什么？")
    assert vec == [0.0] * 4
