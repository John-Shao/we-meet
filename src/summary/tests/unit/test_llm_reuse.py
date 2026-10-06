"""Reuse SDK resources while retaining task-specific observability privacy."""

from types import SimpleNamespace
from unittest.mock import Mock

import openai
import pytest
from pydantic import SecretStr

from summary.core import llm_service, provider_llm


@pytest.fixture()
def configuration(monkeypatch):
    """Configure only fake provider and tracing credentials."""
    value = SimpleNamespace(
        llm_model="qwen3.8-flash",
        llm_base_url="https://provider.invalid/v1",
        llm_api_key=SecretStr("unused"),
        dashscope_api_key=SecretStr("fake-provider"),
        langfuse_enabled=False,
        langfuse_environment="production",
        langfuse_secret_key=SecretStr("fake-tracing"),
        langfuse_public_key="fake-public",
        langfuse_host="https://trace.invalid",
    )
    monkeypatch.setattr(llm_service, "settings", value)
    provider_llm.shutdown()
    yield value
    provider_llm.shutdown()


def test_plain_summary_clients_reuse_sdk_and_preserve_default_timeout(
    configuration, monkeypatch
):
    """Each task has a lease; the SDK retains its original timeout policy."""
    factory = Mock(side_effect=Mock)
    monkeypatch.setattr(openai, "OpenAI", factory)
    first = llm_service.LLMService(llm_service.LLMObservability("s1", "u1"))
    sdk = first._client._entry.client
    first.close()
    second = llm_service.LLMService(llm_service.LLMObservability("s2", "u2"))
    assert second._client._entry.client is sdk
    assert factory.call_count == 1
    assert factory.call_args.kwargs["timeout"] == openai.DEFAULT_TIMEOUT
    second.close()


def test_tracing_rules_and_metadata_remain_task_specific(configuration, monkeypatch):
    """Sharing sockets never shares tracing consent, user IDs or SDK wrappers."""
    from langfuse.openai import openai as traced_openai  # noqa: PLC0415

    configuration.langfuse_enabled = True
    tracing = Mock(side_effect=Mock)
    sdk_factory = Mock(side_effect=Mock)
    monkeypatch.setattr(llm_service, "Langfuse", tracing)
    monkeypatch.setattr(traced_openai, "OpenAI", sdk_factory)
    obs_a = llm_service.LLMObservability("s1", "u1", user_has_tracing_consent=False)
    obs_b = llm_service.LLMObservability("s2", "u2", user_has_tracing_consent=True)
    assert tracing.call_args_list[0].kwargs["mask"]("private") == "[REDACTED]"
    assert tracing.call_args_list[1].kwargs["mask"]("allowed") == "allowed"
    first, second = llm_service.LLMService(obs_a), llm_service.LLMService(obs_b)
    assert first._client is not second._client
    http_a = sdk_factory.call_args_list[0].kwargs["http_client"]
    http_b = sdk_factory.call_args_list[1].kwargs["http_client"]
    assert http_a is not http_b
    assert http_a._transport is http_b._transport
    for service in (first, second):
        service._client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="synthetic"))]
        )
    first.call("system", "first transcript", "tldr")
    second.call("system", "second transcript", "tldr")
    assert (
        first._client.chat.completions.create.call_args.kwargs["metadata"]["user_id"]
        == "u1"
    )
    assert (
        second._client.chat.completions.create.call_args.kwargs["metadata"][
            "langfuse_session_id"
        ]
        == "s2"
    )
    first.close()
    second.close()
    first._client.close.assert_called_once()
    second._client.close.assert_called_once()
    http_a.close()
    http_b.close()


def test_summary_failure_releases_client_and_flushes_tracing(monkeypatch):
    """A failed completion must release its task's SDK resources."""
    from summary.core import celery_worker  # noqa: PLC0415

    observation = Mock()
    service = Mock()
    service.call.side_effect = llm_service.LLMException("fake failure")
    monkeypatch.setattr(
        celery_worker.analytics, "is_feature_enabled", Mock(return_value=False)
    )
    monkeypatch.setattr(
        celery_worker, "LLMObservability", Mock(return_value=observation)
    )
    monkeypatch.setattr(celery_worker, "LLMService", Mock(return_value=service))
    with pytest.raises(llm_service.LLMException):
        celery_worker.summarize_transcription_internals(
            owner_id="u1",
            transcript="private",
            session_id="s1",
        )
    service.close.assert_called_once()
    observation.flush.assert_called_once()
