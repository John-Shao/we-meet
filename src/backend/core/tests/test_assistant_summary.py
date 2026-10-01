"""Local assistant summaries validate input/output without saving conversation text."""

import json
from unittest import mock
from uuid import uuid4

from django.core.cache import cache

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.services.llm_client import LLMClient, LLMIncompleteOutput, LLMUnavailable

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/assistant-summary/"


def test_shared_client_keeps_existing_defaults_and_allows_bounded_summary_calls(
    settings,
):
    """Adding per-request limits must preserve the other meeting callers' defaults."""
    settings.DASHSCOPE_API_KEY = "test-key"
    settings.MEETING_SUMMARY_MODEL = "qwen3.8-flash"
    settings.MEETING_SUMMARY_BASE_URL = "https://example.invalid/v1"
    with mock.patch.object(LLMClient, "__init__", return_value=None) as init:
        LLMClient.from_settings()
        assert init.call_args.kwargs["timeout"] == 60.0
        assert init.call_args.kwargs["max_retries"] is None
        LLMClient.from_settings(timeout=25, max_retries=0)
        assert init.call_args.kwargs["timeout"] == 25
        assert init.call_args.kwargs["max_retries"] == 0
        assert init.call_args.kwargs["base_url"] == settings.MEETING_SUMMARY_BASE_URL


@pytest.fixture
def setup_summary():
    """Use an isolated fake provider; never call a real model in tests."""
    cache.clear()
    client = APIClient()
    client.force_authenticate(UserFactory())
    body = {
        "conversation_id": str(uuid4()),
        "language": "zh",
        "rows": [
            {"id": "u1", "role": "user", "text": "我明天发送报告。", "source": ""},
            {"id": "a1", "role": "assistant", "text": "好的。", "source": ""},
        ],
    }
    with mock.patch("core.api.assistant_summary.LLMClient.from_settings") as factory:
        factory.return_value.chat.return_value = json.dumps(
            {
                "summary": "用户计划发送报告。",
                "decisions": [],
                "tasks": [
                    {
                        "text": "发送报告",
                        "owner": "我",
                        "due": "明天",
                        "source_ids": ["u1"],
                    }
                ],
            }
        )
        yield client, body, factory


def test_summary_is_authenticated_bounded_and_no_store(setup_summary):
    """Reuse the configured model with no retries and validate the source link."""
    client, body, factory = setup_summary
    response = client.post(URL, body, format="json")
    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"
    assert response.data["tasks"][0]["source_ids"] == ["u1"]
    factory.assert_called_once_with(timeout=25, max_retries=0)
    args = factory.return_value.chat.call_args.kwargs
    assert args["require_complete"] is True
    assert json.loads(args["user"])["rows"] == body["rows"]
    factory.return_value.close.assert_called_once()


def test_anonymous_cannot_summarize(setup_summary):
    """Paid generation is never public."""
    _, body, factory = setup_summary
    assert APIClient().post(URL, body, format="json").status_code in (401, 403)
    factory.assert_not_called()


@pytest.mark.parametrize("bad", ["duplicate", "oversize", "empty", "role"])
def test_bad_input_never_reaches_provider(setup_summary, bad):
    """Reject ambiguous and long inputs instead of silently truncating them."""
    client, body, factory = setup_summary
    if bad == "duplicate":
        body["rows"][1]["id"] = "u1"
    elif bad == "oversize":
        body["rows"] = [
            {"id": str(i), "role": "user", "text": "中" * 20000} for i in range(2)
        ]
    elif bad == "empty":
        body["rows"] = []
    else:
        body["rows"][0]["role"] = "system"
    assert client.post(URL, body, format="json").status_code == 400
    factory.assert_not_called()


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        '{"summary":"x"}',
        '{"summary":"x","decisions":[],"tasks":[{"text":"x","owner":"","due":"","source_ids":["invented"]}]}',
    ],
)
def test_malformed_or_uncited_generation_is_not_published(setup_summary, raw):
    """Provider problems return only a safe error, with no raw content."""
    client, body, factory = setup_summary
    factory.return_value.chat.return_value = raw
    response = client.post(URL, body, format="json")
    assert response.status_code == 502
    assert "invented" not in str(response.data)
    factory.return_value.close.assert_called_once()


def test_incomplete_or_unavailable_generation_can_be_retried(setup_summary):
    """Never publish a length-truncated JSON response."""
    client, body, factory = setup_summary
    factory.return_value.chat.side_effect = LLMIncompleteOutput("length")
    assert client.post(URL, body, format="json").status_code == 502
    factory.side_effect = LLMUnavailable("private configuration")
    response = client.post(URL, body, format="json")
    assert response.status_code == 503
    assert "private" not in str(response.data)


def test_generation_is_rate_limited(setup_summary):
    """Avoid repeated expensive requests from one account."""
    client, body, factory = setup_summary
    for _ in range(3):
        assert client.post(URL, body, format="json").status_code == 200
    assert client.post(URL, body, format="json").status_code == 429
    assert factory.return_value.chat.call_count == 3
