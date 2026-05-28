"""Tests for the streaming personal-AI endpoint (Sprint 2.5)."""
# pylint: disable=W0621

import json
from unittest import mock

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory

pytestmark = pytest.mark.django_db


def _parse_sse(body: bytes) -> list[dict]:
    out: list[dict] = []
    for frame in body.decode("utf-8").split("\n\n"):
        frame = frame.strip()
        if frame.startswith("data: "):
            out.append(json.loads(frame[6:]))
    return out


def test_stream_anonymous_caller_rejected():
    client = APIClient()
    response = client.post(
        "/api/v1.0/users/me/ai/ask-stream/",
        {"question": "hi"},
        format="json",
    )
    assert response.status_code == 401


def test_stream_rejects_empty_question():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)
    response = client.post(
        "/api/v1.0/users/me/ai/ask-stream/",
        {"question": "   "},
        format="json",
    )
    assert response.status_code == 400


def test_stream_rejects_invalid_history():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)
    response = client.post(
        "/api/v1.0/users/me/ai/ask-stream/",
        {
            "question": "real",
            "history": [{"role": "tool", "content": "bogus"}],
        },
        format="json",
    )
    assert response.status_code == 400


def test_stream_happy_path():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    fake_events = [
        {
            "type": "meta",
            "rooms_referenced": [
                {"id": "abc", "name": "M", "slug": "m"}
            ],
            "chunks_used": 3,
            "model_used": "ep-test",
        },
        {"type": "delta", "text": "结论"},
        {"type": "delta", "text": "是 5 点半"},
        {"type": "done"},
    ]
    with mock.patch(
        "core.services.personal_ai.PersonalAIService.ask_stream",
        return_value=iter(fake_events),
    ):
        response = client.post(
            "/api/v1.0/users/me/ai/ask-stream/",
            {
                "question": "结论是什么？",
                "history": [
                    {"role": "user", "content": "上班时间有变化吗？"},
                    {"role": "assistant", "content": "改到 9 点。"},
                ],
            },
            format="json",
        )

    assert response.status_code == 200
    assert response["content-type"].startswith("text/event-stream")
    assert response["X-Accel-Buffering"] == "no"

    events = _parse_sse(b"".join(response.streaming_content))
    assert events == fake_events


def test_stream_passes_history_to_service():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)

    with mock.patch(
        "core.services.personal_ai.PersonalAIService.ask_stream",
        return_value=iter([{"type": "done"}]),
    ) as ask:
        client.post(
            "/api/v1.0/users/me/ai/ask-stream/",
            {
                "question": "下班呢？",
                "history": [
                    {"role": "user", "content": "上班时间有变化吗？"},
                    {"role": "assistant", "content": "改到 9 点。"},
                ],
            },
            format="json",
        )
        # Force the generator to be consumed so the mock has been called.
        # client.post fully drains streaming_content above already.

    call = ask.call_args.kwargs
    assert call["user"].pk == user.pk
    assert call["question"] == "下班呢？"
    assert len(call["history"]) == 2
    assert call["history"][0] == {"role": "user", "content": "上班时间有变化吗？"}
