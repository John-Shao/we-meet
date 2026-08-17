"""Legacy Room detail endpoints expose the latest session without aggregation."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import MeetingSessionFactory, RoomFactory, UserFactory
from core.models import ActionItem, MeetingSession, Summary, Transcript

pytestmark = pytest.mark.django_db


def _ended_session(room, started_at):
    return MeetingSessionFactory(
        room=room,
        status=MeetingSession.Status.ENDED,
        started_at=started_at,
        ended_at=started_at + timedelta(minutes=30),
        end_reason=MeetingSession.EndReason.ROOM_FINISHED,
    )


def test_room_artifact_endpoints_select_latest_session():
    user = UserFactory()
    room = RoomFactory(users=[(user, "owner")])
    first = _ended_session(room, timezone.now() - timedelta(hours=3))
    latest = _ended_session(room, timezone.now() - timedelta(hours=1))
    first_summary = Summary.objects.create(
        room=room, session=first, content="old", status=Summary.Status.SUCCESS
    )
    latest_summary = Summary.objects.create(
        room=room, session=latest, content="latest", status=Summary.Status.SUCCESS
    )
    ActionItem.objects.create(
        room=room, summary=first_summary, content="old item", sort_order=0
    )
    ActionItem.objects.create(
        room=room, summary=latest_summary, content="latest item", sort_order=0
    )
    Transcript.objects.create(
        room=room,
        session=first,
        speaker_identity="user",
        text="old transcript",
        started_at=first.started_at,
    )
    Transcript.objects.create(
        room=room,
        session=latest,
        speaker_identity="user",
        text="latest transcript",
        started_at=latest.started_at,
    )
    client = APIClient()
    client.force_login(user)
    base = f"/api/v1.0/rooms/{room.id}"

    summary_response = client.get(f"{base}/summary/")
    items_response = client.get(f"{base}/action-items/")
    transcripts_response = client.get(f"{base}/transcripts/")

    assert summary_response.status_code == 200
    assert summary_response.json()["content"] == "latest"
    assert [item["content"] for item in items_response.json()] == ["latest item"]
    assert [row["text"] for row in transcripts_response.json()] == ["latest transcript"]


def test_room_regenerate_targets_latest_session_with_transcripts():
    user = UserFactory()
    room = RoomFactory(users=[(user, "owner")])
    first = _ended_session(room, timezone.now() - timedelta(hours=3))
    latest = _ended_session(room, timezone.now() - timedelta(hours=1))
    for session in (first, latest):
        Transcript.objects.create(
            room=room,
            session=session,
            speaker_identity="user",
            text=str(session.id),
            started_at=session.started_at,
        )
    client = APIClient()
    client.force_login(user)

    with mock.patch(
        "core.tasks.summary.generate_meeting_summary.apply_async"
    ) as schedule:
        response = client.post(f"/api/v1.0/rooms/{room.id}/summary/regenerate/")

    assert response.status_code == 202
    schedule.assert_called_once_with(args=[str(latest.id), True])
