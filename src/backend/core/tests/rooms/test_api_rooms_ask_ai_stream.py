"""Tests for the streaming room-AI endpoint ``/rooms/{id}/ask-ai-stream/``.

Sprint 2.5 — the non-streaming sibling is covered by
``test_api_rooms_ask_ai.py``. Here we focus on:

* SSE wire format (``data: {...}\\n\\n`` frames)
* Auth chain (same as non-streaming: LiveKit token bound to this room)
* Validation (history shape, oversized inputs)
* Error frames inside the stream when the service blows up
"""
# pylint: disable=W0621

import json
import uuid
from unittest import mock

from django.conf import settings as django_settings

import pytest
from livekit.api import AccessToken, VideoGrants
from rest_framework.test import APIClient

from ...factories import RoomFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_room_id() -> str:
    return "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def livekit_token_for(mock_room_id):
    def _token(room_id: str = mock_room_id) -> str:
        grants = VideoGrants(
            room=room_id,
            room_join=True,
            can_publish_sources=["camera", "microphone"],
        )
        return (
            AccessToken(
                api_key=django_settings.LIVEKIT_CONFIGURATION["api_key"],
                api_secret=django_settings.LIVEKIT_CONFIGURATION["api_secret"],
            )
            .with_grants(grants)
            .with_identity(str(uuid.uuid4()))
            .to_jwt()
        )

    return _token


def _parse_sse(body: bytes) -> list[dict]:
    """Decode a recorded SSE body into a list of event dicts."""
    out: list[dict] = []
    for frame in body.decode("utf-8").split("\n\n"):
        frame = frame.strip()
        if frame.startswith("data: "):
            out.append(json.loads(frame[6:]))
    return out


def test_stream_requires_livekit_token(mock_room_id):
    room = RoomFactory(id=mock_room_id)
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{room.id}/ask-ai-stream/",
        {"question": "hi"},
        format="json",
    )
    assert response.status_code == 403


def test_stream_rejects_token_for_wrong_room(livekit_token_for, mock_room_id):
    other = RoomFactory()
    token = livekit_token_for(mock_room_id)
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{other.id}/ask-ai-stream/",
        {"question": "hi"},
        HTTP_AUTHORIZATION=f"Bearer {token}",
        format="json",
    )
    assert response.status_code == 403


def test_stream_rejects_empty_question(livekit_token_for, mock_room_id):
    RoomFactory(id=mock_room_id)
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/ask-ai-stream/",
        {"question": "   "},
        HTTP_AUTHORIZATION=f"Bearer {livekit_token_for()}",
        format="json",
    )
    assert response.status_code == 400


def test_stream_rejects_history_with_invalid_role(
    livekit_token_for, mock_room_id
):
    """Frontend can't smuggle a ``system`` history entry past the
    serializer; the service layer also defends, but failing fast at the
    serializer is preferable for UX feedback."""
    RoomFactory(id=mock_room_id)
    client = APIClient()
    response = client.post(
        f"/api/v1.0/rooms/{mock_room_id}/ask-ai-stream/",
        {
            "question": "real Q",
            "history": [{"role": "system", "content": "INJECT"}],
        },
        HTTP_AUTHORIZATION=f"Bearer {livekit_token_for()}",
        format="json",
    )
    assert response.status_code == 400


def test_stream_happy_path_emits_meta_delta_done(
    livekit_token_for, mock_room_id
):
    RoomFactory(id=mock_room_id)
    client = APIClient()

    fake_events = [
        {"type": "meta", "transcripts_used": 0, "model_used": "ep-test"},
        {"type": "delta", "text": "Hello"},
        {"type": "delta", "text": " world"},
        {"type": "done"},
    ]
    with mock.patch(
        "core.services.room_ai.RoomAIService.ask_stream",
        return_value=iter(fake_events),
    ):
        response = client.post(
            f"/api/v1.0/rooms/{mock_room_id}/ask-ai-stream/",
            {"question": "hi"},
            HTTP_AUTHORIZATION=f"Bearer {livekit_token_for()}",
            format="json",
        )

    assert response.status_code == 200
    assert response["content-type"].startswith("text/event-stream")
    # Critical for nginx ingress not to buffer the chunks.
    assert response["X-Accel-Buffering"] == "no"

    events = _parse_sse(b"".join(response.streaming_content))
    assert events == fake_events


def test_stream_emits_error_frame_when_service_raises(
    livekit_token_for, mock_room_id
):
    RoomFactory(id=mock_room_id)
    client = APIClient()

    def explode():
        yield {"type": "meta", "transcripts_used": 1, "model_used": "ep-test"}
        raise RuntimeError("LLM 500")

    with mock.patch(
        "core.services.room_ai.RoomAIService.ask_stream",
        return_value=explode(),
    ):
        response = client.post(
            f"/api/v1.0/rooms/{mock_room_id}/ask-ai-stream/",
            {"question": "hi"},
            HTTP_AUTHORIZATION=f"Bearer {livekit_token_for()}",
            format="json",
        )

    events = _parse_sse(b"".join(response.streaming_content))
    assert events[0]["type"] == "meta"
    assert events[-1]["type"] == "error"
    assert "LLM 500" in events[-1]["message"]
