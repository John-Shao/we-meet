"""Unit tests for ``LLMClient.chat_stream`` (Sprint 2.5).

We don't talk to Ark in CI — patch the ``openai.OpenAI`` factory so
``client.chat.completions.create(stream=True)`` returns a controllable
iterable of chunk objects matching the openai SDK shape.
"""
# pylint: disable=W0621

from types import SimpleNamespace
from unittest import mock

import pytest

from core.services.llm_client import LLMClient


def _chunk(text: str | None):
    """Mimic the openai SDK's chunk object: ``ev.choices[0].delta.content``."""
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text))]
    )


@pytest.fixture
def fake_openai(monkeypatch):
    instance = mock.MagicMock()

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            pass

        chat = instance.chat

    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    return instance


def test_chat_stream_yields_each_non_empty_delta(fake_openai):
    fake_openai.chat.completions.create.return_value = iter(
        [_chunk("结论"), _chunk("是 5"), _chunk("点半")]
    )
    client = LLMClient(api_key="k", model="ep-test")
    out = list(
        client.chat_stream(
            messages=[
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "下班呢？"},
            ]
        )
    )
    assert out == ["结论", "是 5", "点半"]


def test_chat_stream_filters_empty_and_none_deltas(fake_openai):
    """Ark sometimes emits empty content at stream start/end — those
    bubble up as `""` or ``None`` and must be skipped so callers can
    naively concatenate."""
    fake_openai.chat.completions.create.return_value = iter(
        [_chunk(None), _chunk(""), _chunk("real"), _chunk(None)]
    )
    client = LLMClient(api_key="k", model="ep-test")
    assert list(client.chat_stream(messages=[{"role": "user", "content": "hi"}])) == [
        "real"
    ]


def test_chat_stream_passes_stream_true_and_messages_verbatim(fake_openai):
    fake_openai.chat.completions.create.return_value = iter([_chunk("x")])
    client = LLMClient(api_key="k", model="ep-test")
    msgs = [
        {"role": "system", "content": "rag context"},
        {"role": "user", "content": "Q1"},
        {"role": "assistant", "content": "A1"},
        {"role": "user", "content": "Q2 (follow-up)"},
    ]
    list(client.chat_stream(messages=msgs, temperature=0.4, max_tokens=500))

    call = fake_openai.chat.completions.create.call_args.kwargs
    assert call["stream"] is True
    assert call["model"] == "ep-test"
    assert call["messages"] == msgs
    assert call["temperature"] == 0.4
    assert call["max_tokens"] == 500


def test_chat_stream_handles_empty_choices(fake_openai):
    """Some SSE keepalive frames carry ``choices=[]``. Don't crash."""
    fake_openai.chat.completions.create.return_value = iter(
        [SimpleNamespace(choices=[]), _chunk("ok")]
    )
    client = LLMClient(api_key="k", model="ep-test")
    assert list(client.chat_stream(messages=[{"role": "user", "content": "hi"}])) == [
        "ok"
    ]
