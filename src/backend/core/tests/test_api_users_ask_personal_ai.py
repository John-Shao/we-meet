"""Tests for the cross-meeting AI endpoint ``/users/me/ai/ask/`` (Sprint 2.4)."""
# pylint: disable=W0621

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core.factories import UserFactory
from core.services.llm_client import LLMUnavailable

pytestmark = pytest.mark.django_db


def _stub_ok(answer="ok"):
    return mock.patch(
        "core.services.personal_ai.PersonalAIService.ask",
        return_value={
            "answer": answer,
            "chunks_used": 3,
            "rooms_referenced": [
                {"id": "60eb0000-0000-0000-0000-000000000000", "name": "M", "slug": "m"}
            ],
            "model_used": "ep-test-llm",
        },
    )


def test_anonymous_caller_rejected():
    client = APIClient()
    response = client.post("/api/v1.0/users/me/ai/ask/", {"question": "hi"}, format="json")
    assert response.status_code == 401


def test_rejects_empty_question():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)
    response = client.post(
        "/api/v1.0/users/me/ai/ask/", {"question": "  "}, format="json"
    )
    assert response.status_code == 400


def test_rejects_overlong_question():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)
    response = client.post(
        "/api/v1.0/users/me/ai/ask/",
        {"question": "x" * 501},
        format="json",
    )
    assert response.status_code == 400


def test_happy_path_returns_service_payload():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)
    with _stub_ok(answer="结论…") as ask:
        response = client.post(
            "/api/v1.0/users/me/ai/ask/",
            {"question": "上周关于考勤的会议结论是什么？"},
            format="json",
        )
    assert response.status_code == 200
    body = response.json()
    assert body["answer"] == "结论…"
    assert body["chunks_used"] == 3
    assert body["model_used"] == "ep-test-llm"
    assert len(body["rooms_referenced"]) == 1

    # Service called with the authenticated user + stripped question.
    assert ask.call_args.kwargs["user"].pk == user.pk
    assert ask.call_args.kwargs["question"] == "上周关于考勤的会议结论是什么？"


def test_returns_503_when_embedding_unavailable():
    user = UserFactory()
    client = APIClient()
    client.force_login(user)
    with mock.patch(
        "core.services.personal_ai.PersonalAIService.ask",
        side_effect=LLMUnavailable("missing key"),
    ):
        response = client.post(
            "/api/v1.0/users/me/ai/ask/",
            {"question": "anything"},
            format="json",
        )
    assert response.status_code == 503
    assert "missing key" in response.json()["error"]
