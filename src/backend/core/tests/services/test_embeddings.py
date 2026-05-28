"""Unit tests for ``EmbeddingClient`` (Sprint 2.4).

Ark multimodal-embeddings isn't OpenAI-compatible, so we mock at the
``urllib.request.urlopen`` level instead of patching an SDK.
"""
# pylint: disable=W0621

import json
from io import BytesIO
from unittest import mock
import urllib.error

import pytest

from core.services.embeddings import EmbeddingClient, EmbeddingUnavailable


def _ark_response(embedding: list[float], *, text_tokens: int = 10):
    """Build a fake Ark multimodal-embedding success payload (bytes)."""
    body = {
        "created": 1779929915,
        "data": {
            "embedding": embedding,
            "object": "embedding",
        },
        "id": "fake-id",
        "model": "ep-test",
        "object": "list",
        "usage": {
            "prompt_tokens": text_tokens,
            "prompt_tokens_details": {
                "image_tokens": 0,
                "text_tokens": text_tokens,
            },
            "total_tokens": text_tokens,
        },
    }
    return json.dumps(body).encode("utf-8")


class _FakeResp:
    """Context-manager mock matching what ``urlopen()`` returns."""

    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


@pytest.fixture
def mock_urlopen(monkeypatch):
    """Patch ``urllib.request.urlopen`` inside the module under test."""
    m = mock.MagicMock()
    monkeypatch.setattr(
        "core.services.embeddings.urllib.request.urlopen", m
    )
    return m


# ---------------------------------------------------------------------
# Config / errors
# ---------------------------------------------------------------------


def test_from_settings_raises_when_misconfigured(settings):
    settings.ARK_API_KEY = ""
    settings.DOUBAO_EMBEDDING_ENDPOINT = ""
    with pytest.raises(EmbeddingUnavailable):
        EmbeddingClient.from_settings()


def test_endpoint_path_is_multimodal():
    """Sanity: the constructed URL must hit ``/embeddings/multimodal``,
    not the OpenAI-compatible ``/embeddings`` path."""
    client = EmbeddingClient(api_key="k", model="ep-test")
    # _endpoint is internal but the test would silently regress if we
    # didn't pin the path.
    assert client._endpoint.endswith("/api/v3/embeddings/multimodal")  # noqa: SLF001


# ---------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------


def test_embed_returns_vector(mock_urlopen):
    mock_urlopen.return_value = _FakeResp(_ark_response([0.1, 0.2, 0.3, 0.4]))
    client = EmbeddingClient(api_key="k", model="ep-test")
    vec = client.embed("hello")
    assert vec == [0.1, 0.2, 0.3, 0.4]
    mock_urlopen.assert_called_once()


def test_batch_embed_preserves_order(mock_urlopen):
    """Each text → one HTTP call; results returned in the input order."""
    responses = [
        _FakeResp(_ark_response([float(i)] * 4)) for i in range(3)
    ]
    mock_urlopen.side_effect = responses
    client = EmbeddingClient(api_key="k", model="ep-test")
    vecs = client.batch_embed(["a", "b", "c"])
    assert vecs == [[0.0] * 4, [1.0] * 4, [2.0] * 4]
    assert mock_urlopen.call_count == 3


def test_batch_embed_request_shape(mock_urlopen):
    """Request body must wrap each text into ``{type:'text', text:...}``."""
    mock_urlopen.return_value = _FakeResp(_ark_response([0.0] * 2))
    client = EmbeddingClient(api_key="k", model="ep-test")
    client.embed("你好")

    # urlopen was called with a Request object — sniff its data.
    req = mock_urlopen.call_args.args[0]
    sent = json.loads(req.data.decode("utf-8"))
    assert sent["model"] == "ep-test"
    assert sent["input"] == [{"type": "text", "text": "你好"}]
    assert req.get_method() == "POST"
    assert req.headers.get("Authorization") == "Bearer k"


def test_batch_embed_empty_input_skips_call(mock_urlopen):
    client = EmbeddingClient(api_key="k", model="ep-test")
    assert client.batch_embed([]) == []
    mock_urlopen.assert_not_called()


def test_batch_embed_rejects_empty_string(mock_urlopen):
    client = EmbeddingClient(api_key="k", model="ep-test")
    with pytest.raises(ValueError):
        client.batch_embed(["ok", ""])
    mock_urlopen.assert_not_called()


def test_embed_query_returns_none_for_blank(mock_urlopen):
    client = EmbeddingClient(api_key="k", model="ep-test")
    assert client.embed_query("   ") is None
    assert client.embed_query("") is None
    mock_urlopen.assert_not_called()


def test_embed_query_returns_vector_for_real_question(mock_urlopen):
    mock_urlopen.return_value = _FakeResp(_ark_response([0.5, 0.6]))
    client = EmbeddingClient(api_key="k", model="ep-test")
    assert client.embed_query("结论是什么？") == [0.5, 0.6]


# ---------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------


def test_http_error_surfaces_message(mock_urlopen):
    mock_urlopen.side_effect = urllib.error.HTTPError(
        url="x", code=429, msg="too many requests",
        hdrs=None, fp=BytesIO(b'{"error": "throttled"}')
    )
    client = EmbeddingClient(api_key="k", model="ep-test")
    with pytest.raises(RuntimeError, match="HTTP 429"):
        client.embed("hi")


def test_malformed_response_rejected(mock_urlopen):
    """If the API returns 200 with a shape we don't recognise (e.g. an
    upstream regression), we fail loudly rather than persisting garbage."""
    mock_urlopen.return_value = _FakeResp(
        json.dumps({"data": [], "object": "list"}).encode("utf-8")
    )
    client = EmbeddingClient(api_key="k", model="ep-test")
    with pytest.raises(RuntimeError, match="Unexpected"):
        client.embed("hi")
