"""Video overview uses sessions, never summaries or device-local history."""

from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/rooms/video-meetings/"


def test_pending_includes_overdue_and_all_pages_but_excludes_started_closed_and_ai():
    user = factories.UserFactory()
    now = timezone.now()
    pending = [
        factories.RoomFactory(
            users=[(user, "owner")], scheduled_at=now - timedelta(days=i)
        )
        for i in range(52)
    ]
    started = factories.RoomFactory(
        users=[(user, "member")], scheduled_at=now + timedelta(days=1)
    )
    session = factories.MeetingSessionFactory(room=started)
    factories.RoomFactory(users=[(user, "owner")], ended_at=now)
    factories.RoomFactory(users=[(user, "owner")], name="__JUSI_AI_SESSION__-test")
    factories.RoomFactory()  # Another user's private appointment.
    client = APIClient()
    client.force_login(user)
    response = client.get(URL)
    assert response.status_code == 200
    data = response.json()
    assert [r["id"] for r in data["scheduled"]] == [
        str(r.id) for r in reversed(pending)
    ]
    assert all(r["is_owner"] and r["status"] == "pending" for r in data["scheduled"])
    assert data["recent"][0]["meeting_session_id"] == str(session.id)
    assert data["recent"][0]["is_owner"] is False
    assert "livekit" not in data["recent"][0]
    assert not models.MeetingRecord.objects.exists()


def test_history_returns_latest_ten_exact_sessions_without_summaries():
    user = factories.UserFactory()
    room = factories.RoomFactory(users=[(user, "owner")])
    now = timezone.now()
    sessions = [
        factories.MeetingSessionFactory(
            room=room,
            started_at=now - timedelta(days=i),
            ended_at=now - timedelta(days=i) + timedelta(minutes=1),
            status="ended",
            end_reason="room_finished",
        )
        for i in range(1, 12)
    ]
    active = factories.MeetingSessionFactory(room=room, started_at=now)
    factories.MeetingSessionFactory()  # Not a member: invisible.
    client = APIClient()
    client.force_login(user)
    data = client.get(URL).json()
    assert data["scheduled"] == []
    assert [r["meeting_session_id"] for r in data["recent"]] == [
        str(s.id) for s in [active, *sessions[:9]]
    ]
    assert data["recent"][0]["status"] == "active"
    assert data["recent"][1]["status"] == "ended"
    models.ResourceAccess.objects.filter(resource=room, user=user).delete()
    assert client.get(URL).json() == {"scheduled": [], "recent": []}


def test_anonymous_cannot_read_overview():
    assert APIClient().get(URL).status_code in (401, 403)


def test_session_metadata_is_exact_and_membership_scoped():
    user = factories.UserFactory()
    room = factories.RoomFactory(users=[(user, "member")])
    session = factories.MeetingSessionFactory(room=room)
    other = factories.MeetingSessionFactory()
    client = APIClient()
    client.force_login(user)
    url = f"/api/v1.0/rooms/{room.id}/video-session/"
    assert client.get(url, {"session_id": session.id}).json()["status"] == "active"
    assert client.get(url, {"session_id": other.id}).status_code == 404
    assert client.get(url, {"session_id": "invalid"}).status_code == 400
    models.ResourceAccess.objects.filter(resource=room, user=user).delete()
    assert client.get(url, {"session_id": session.id}).status_code == 404
