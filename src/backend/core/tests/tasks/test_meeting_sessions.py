"""Tests for stale meeting-session reconciliation."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest
from livekit import api

from core import models
from core.factories import MeetingSessionFactory
from core.tasks.meeting_sessions import reconcile_active_meeting_sessions

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def stale_threshold(settings):
    settings.MEETING_SESSION_STALE_AFTER_SECONDS = 3600


def _stale_session(sid="RM_stale"):
    return MeetingSessionFactory(
        livekit_room_sid=sid,
        started_at=timezone.now() - timedelta(hours=2),
    )


@mock.patch("core.tasks.meeting_sessions._list_livekit_rooms", return_value=[])
def test_reconcile_closes_stale_session_missing_from_livekit(_mock_list):
    session = _stale_session()

    result = reconcile_active_meeting_sessions()

    session.refresh_from_db()
    assert result == {"checked": 1, "closed": 1, "superseded": 0}
    assert session.status == models.MeetingSession.Status.ENDED
    assert session.end_reason == models.MeetingSession.EndReason.RECONCILED


@mock.patch("core.tasks.meeting_sessions._list_livekit_rooms")
def test_reconcile_keeps_matching_livekit_sid(mock_list):
    session = _stale_session()
    mock_list.return_value = [
        api.Room(name=str(session.room_id), sid=session.livekit_room_sid)
    ]

    result = reconcile_active_meeting_sessions()

    session.refresh_from_db()
    assert result == {"checked": 1, "closed": 0, "superseded": 0}
    assert session.status == models.MeetingSession.Status.ACTIVE


@mock.patch("core.tasks.meeting_sessions._list_livekit_rooms")
def test_reconcile_projects_newer_replacement_sid(mock_list):
    session = _stale_session()
    replacement_start = timezone.now().replace(microsecond=0)
    mock_list.return_value = [
        api.Room(
            name=str(session.room_id),
            sid="RM_replacement",
            creation_time=int(replacement_start.timestamp()),
        )
    ]

    result = reconcile_active_meeting_sessions()

    session.refresh_from_db()
    replacement = models.MeetingSession.objects.get(livekit_room_sid="RM_replacement")
    assert result == {"checked": 1, "closed": 0, "superseded": 1}
    assert session.end_reason == models.MeetingSession.EndReason.SUPERSEDED
    assert replacement.status == models.MeetingSession.Status.ACTIVE


@mock.patch(
    "core.tasks.meeting_sessions._list_livekit_rooms",
    side_effect=RuntimeError("LiveKit unavailable"),
)
def test_reconcile_does_not_close_on_livekit_api_failure(_mock_list):
    session = _stale_session()

    with pytest.raises(RuntimeError, match="LiveKit unavailable"):
        reconcile_active_meeting_sessions()

    session.refresh_from_db()
    assert session.status == models.MeetingSession.Status.ACTIVE
