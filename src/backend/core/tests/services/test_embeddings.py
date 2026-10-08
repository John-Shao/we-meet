"""Qwen embedding protocol and validation tests; no real provider calls."""
# pylint: disable=W0621

import json
import urllib.error
from io import BytesIO
from unittest import mock

import pytest

from core.services.embeddings import EmbeddingClient, EmbeddingUnavailable


def _qwen_response(embedding: list[float], *, text_tokens: int = 10):
    """Build a fake Bailian OpenAI-compatible embedding response."""
    body = {
        "created": 1779929915,
        "data": [{"embedding": embedding, "object": "embedding", "index": 0}],
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
        "core.services.embeddings.provider_http.urlopen", m
    )
    return m


# ---------------------------------------------------------------------
# Config / errors
# ---------------------------------------------------------------------


def test_from_settings_raises_when_misconfigured(settings):
    settings.DASHSCOPE_API_KEY = ""
    settings.QWEN_EMBEDDING_MODEL = "text-embedding-v4"
    with pytest.raises(EmbeddingUnavailable):
        EmbeddingClient.from_settings()


def test_endpoint_path_is_qwen_compatible():
    """Use Bailian text embeddings, with no Ark fallback."""
    client = EmbeddingClient(api_key="k", model="ep-test")
    # _endpoint is internal but the test would silently regress if we
    # didn't pin the path.
    assert client._endpoint.endswith("/compatible-mode/v1/embeddings")


# ---------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------


def test_embed_returns_vector(mock_urlopen):
    expected = [0.1, 0.2, 0.3, 0.4] * 256
    mock_urlopen.return_value = _FakeResp(_qwen_response(expected))
    client = EmbeddingClient(api_key="k", model="ep-test")
    vec = client.embed("hello")
    assert vec == expected
    mock_urlopen.assert_called_once()


def test_batch_embed_preserves_order(mock_urlopen):
    """Provider indexes restore order even if the response is shuffled."""
    mock_urlopen.return_value = _FakeResp(json.dumps({"data": [
        {"index": i, "embedding": [float(i)] * 1024} for i in (2, 0, 1)
    ]}).encode())
    client = EmbeddingClient(api_key="k", model="ep-test")
    vecs = client.batch_embed(["a", "b", "c"])
    assert vecs == [[0.0] * 1024, [1.0] * 1024, [2.0] * 1024]
    assert mock_urlopen.call_count == 1
    assert json.loads(mock_urlopen.call_args.args[0].data)["input"] == ["a", "b", "c"]


def test_batch_embed_request_shape(mock_urlopen):
    """Request body uses string inputs and a stable vector dimension."""
    mock_urlopen.return_value = _FakeResp(_qwen_response([0.0] * 1024))
    client = EmbeddingClient(api_key="k", model="ep-test")
    client.embed("你好")

    # urlopen was called with a Request object — sniff its data.
    req = mock_urlopen.call_args.args[0]
    sent = json.loads(req.data.decode("utf-8"))
    assert sent["model"] == "ep-test"
    assert sent["input"] == ["你好"]
    assert sent["dimensions"] == 1024
    assert sent["encoding_format"] == "float"
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
    mock_urlopen.return_value = _FakeResp(_qwen_response([0.5, 0.6] * 512))
    client = EmbeddingClient(api_key="k", model="ep-test")
    assert client.embed_query("结论是什么？") == [0.5, 0.6] * 512


def test_batches_have_ten_inputs_and_guard_each_paid_request(mock_urlopen):
    """A 23-chunk index needs three requests; each still checks its snapshot."""
    guard = mock.Mock()

    def response(req, **_kwargs):
        texts = json.loads(req.data)["input"]
        return _FakeResp(json.dumps({"data": [
            {"index": i, "embedding": [float(text)] * 1024}
            for i, text in reversed(list(enumerate(texts)))
        ]}).encode())

    mock_urlopen.side_effect = response
    client = EmbeddingClient(api_key="k", model="text-embedding-v4")
    assert client.batch_embed(map(str, range(23)), before_request=guard) == [
        [float(i)] * 1024 for i in range(23)
    ]
    assert [len(json.loads(call.args[0].data)["input"]) for call in mock_urlopen.call_args_list] == [10, 10, 3]
    assert guard.call_count == 3


def test_changed_snapshot_stops_the_next_batch(mock_urlopen):
    guard = mock.Mock(side_effect=[None, RuntimeError("stale")])
    mock_urlopen.return_value = _FakeResp(json.dumps({"data": [
        {"index": i, "embedding": [0.0] * 1024} for i in range(10)
    ]}).encode())
    with pytest.raises(RuntimeError, match="stale"):
        EmbeddingClient(api_key="k", model="text-embedding-v4").batch_embed(
            ["text"] * 11, before_request=guard
        )
    mock_urlopen.assert_called_once()


@pytest.mark.parametrize("rows", [
    [{"index": 0, "embedding": [0.0] * 1024}] * 2,
    [{"index": i, "embedding": [0.0] * 1024} for i in (0, 2)],
    [{"index": i, "embedding": [0.0] * 1024} for i in (False, 1)],
    [{"index": i, "embedding": [0.0] * 512} for i in (0, 1)],
    [{"index": i, "embedding": [float("nan")] * 1024} for i in (0, 1)],
    [{"index": i, "embedding": [True] * 1024} for i in (0, 1)],
    [{"embedding": [0.0] * 1024}, {"index": 1, "embedding": [0.0] * 1024}],
    [None, {"index": 1, "embedding": [0.0] * 1024}],
])
def test_invalid_batch_never_returns_partial_vectors(mock_urlopen, rows):
    mock_urlopen.return_value = _FakeResp(json.dumps({"data": rows}).encode())
    with pytest.raises(RuntimeError):
        EmbeddingClient(api_key="k", model="text-embedding-v4").batch_embed(["a", "b"])


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
