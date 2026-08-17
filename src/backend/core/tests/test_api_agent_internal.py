"""Tests for the internal transcript ingestion contract."""

import uuid
from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MeetingSessionFactory, RoomFactory

pytestmark = pytest.mark.django_db

ENDPOINT = "/api/agent/transcripts/"
TOKEN = "agent-test-token"


def _client(settings):
    settings.AGENT_INTERNAL_API_TOKEN = TOKEN
    return APIClient()


def _payload(room, **overrides):
    started_at = timezone.now().replace(microsecond=0)
    payload = {
        "room_id": str(room.id),
        "livekit_room_sid": "RM_transcript",
        "ingest_id": str(uuid.uuid4()),
        "speaker_identity": "speaker-1",
        "speaker_name": "Speaker One",
        "text": "A durable transcript line",
        "language": "en-us",
        "started_at": started_at.isoformat(),
        "ended_at": (started_at + timedelta(seconds=2)).isoformat(),
        "translations": {"zh-cn": "一条持久化字幕"},
    }
    payload.update(overrides)
    return payload


def _post(client, payload):
    return client.post(
        ENDPOINT,
        payload,
        format="json",
        HTTP_X_AGENT_TOKEN=TOKEN,
    )


def test_ingest_transcript_creates_session_and_is_idempotent(settings):
    """A SID and ingest key should produce one session-scoped artifact."""

    room = RoomFactory()
    client = _client(settings)
    payload = _payload(room)

    first = _post(client, payload)
    replay = _post(client, payload)

    assert first.status_code == 201
    assert first.json()["created"] is True
    assert replay.status_code == 200
    assert replay.json()["created"] is False
    assert replay.json()["id"] == first.json()["id"]
    assert models.Transcript.objects.count() == 1

    transcript = models.Transcript.objects.select_related("session").get()
    assert transcript.ingest_id == uuid.UUID(payload["ingest_id"])
    assert transcript.session.livekit_room_sid == payload["livekit_room_sid"]
    assert (
        transcript.session.start_source
        == models.MeetingSession.StartSource.TRANSCRIPT
    )
    assert first.json()["session_id"] == str(transcript.session_id)


def test_ingest_transcript_rejects_reused_key_with_different_payload(settings):
    """An ingest key cannot silently alias two utterances."""

    room = RoomFactory()
    client = _client(settings)
    payload = _payload(room)
    assert _post(client, payload).status_code == 201

    conflict = _post(
        client,
        {
            **payload,
            "livekit_room_sid": "RM_conflicting_replay",
            "text": "different text",
        },
    )

    assert conflict.status_code == 409
    assert models.Transcript.objects.count() == 1
    assert models.MeetingSession.objects.count() == 1


def test_legacy_transcript_without_sid_binds_active_session(settings):
    """Old agents remain compatible and use the unambiguous active session."""

    room = RoomFactory()
    started_at = timezone.now().replace(microsecond=0)
    session = MeetingSessionFactory(
        room=room,
        started_at=started_at - timedelta(minutes=1),
    )
    payload = _payload(
        room,
        started_at=started_at.isoformat(),
        livekit_room_sid="",
        ingest_id=None,
    )

    response = _post(_client(settings), payload)

    assert response.status_code == 201
    transcript = models.Transcript.objects.get()
    assert transcript.session == session
    assert transcript.ingest_id is None


def test_legacy_transcript_without_candidate_remains_room_only(settings):
    """Rollout compatibility retains an unresolved write instead of guessing."""

    room = RoomFactory()
    payload = _payload(room, livekit_room_sid="", ingest_id=None)

    response = _post(_client(settings), payload)

    assert response.status_code == 201
    assert response.json()["session_id"] is None
    assert models.Transcript.objects.get().session_id is None


def test_ingest_transcript_rejects_sid_owned_by_another_room(settings):
    """A LiveKit SID cannot move artifacts across Room ACL boundaries."""

    room = RoomFactory()
    other_session = MeetingSessionFactory(livekit_room_sid="RM_foreign")
    payload = _payload(room, livekit_room_sid=other_session.livekit_room_sid)

    response = _post(_client(settings), payload)

    assert response.status_code == 409
    assert models.Transcript.objects.count() == 0
