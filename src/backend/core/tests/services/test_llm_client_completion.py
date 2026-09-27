"""Non-streaming completion diagnostics never retain provider content."""

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from core.services.llm_client import LLMClient, LLMIncompleteOutput


@pytest.mark.parametrize(
    "reason", ["length", "content_filter", "tool_calls", "private-data", None]
)
def test_incomplete_output_preserves_only_safe_reason_and_usage(reason):
    response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason=reason,
                message=SimpleNamespace(content="private translation"),
            )
        ],
        usage=None,
    )
    with patch("openai.OpenAI") as sdk:
        sdk.return_value.chat.completions.create.return_value = response
        client = LLMClient(api_key="test", model="qwen-test")
        client._report_usage = Mock()
        with pytest.raises(LLMIncompleteOutput) as error:
            client.chat(system="system", user="private source", require_complete=True)
        client._report_usage.assert_called_once_with(None, response)
        assert error.value.finish_reason == (
            reason
            if reason in ("length", "content_filter", "tool_calls")
            else "unknown"
        )
        assert "private" not in str(error.value)
        assert isinstance(error.value, ValueError)


def test_complete_output_and_non_strict_call_keep_existing_behavior():
    with patch("openai.OpenAI") as sdk:
        choice = SimpleNamespace(
            finish_reason="stop", message=SimpleNamespace(content=" translated ")
        )
        sdk.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[choice]
        )
        client = LLMClient(api_key="test", model="qwen-test")
        assert client.chat(system="s", user="u", require_complete=True) == "translated"
        choice.finish_reason = "length"
        assert client.chat(system="s", user="u") == "translated"
        sdk.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[]
        )
        with pytest.raises(LLMIncompleteOutput) as error:
            client.chat(system="s", user="u", require_complete=True)
        assert error.value.finish_reason == "unknown"
