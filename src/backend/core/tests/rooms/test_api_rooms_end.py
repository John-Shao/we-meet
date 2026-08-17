"""Tests for ending a reusable Room with an active MeetingSession."""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MeetingSessionFactory, RoomFactory, UserFactory
from core.services.participants_management import ParticipantsManagement

pytestmark = pytest.mark.django_db


@mock.patch.object(ParticipantsManagement, "remove_all")
def test_owner_end_closes_active_meeting_session(mock_remove_all):
    owner = UserFactory()
    room = RoomFactory(users=[(owner, models.RoleChoices.OWNER)])
    session = MeetingSessionFactory(room=room)
    client = APIClient()
    client.force_login(owner)

    response = client.post(f"/api/v1.0/rooms/{room.id}/end/")

    assert response.status_code == 200
    room.refresh_from_db()
    session.refresh_from_db()
    assert room.ended_at is not None
    assert session.status == models.MeetingSession.Status.ENDED
    assert session.end_reason == models.MeetingSession.EndReason.OWNER_ENDED
    assert session.ended_at == room.ended_at
    mock_remove_all.assert_called_once_with(room_name=str(room.id))
