"""Join-time readiness must not expose private controls or manufacture sessions."""

import uuid

from django.utils import timezone

import pytest
from livekit.api import AccessToken, VideoGrants
from rest_framework.test import APIClient

from core import models
from core.factories import (
    MeetingParticipationFactory,
    MeetingSessionFactory,
    RoomFactory,
    UserFactory,
)

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/meeting-session-status/"


def client_for_room(settings, room, user=None, can_join=True):
    token = (
        AccessToken(
            settings.LIVEKIT_CONFIGURATION["api_key"],
            settings.LIVEKIT_CONFIGURATION["api_secret"],
        )
        .with_identity(user.sub if user else str(uuid.uuid4()))
        .with_grants(VideoGrants(room=str(room.pk), room_join=can_join))
        .to_jwt()
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


def test_waits_for_room_projection_then_exposes_owner_readiness(settings):
    user = UserFactory()
    room = RoomFactory(users=[(user, models.RoleChoices.OWNER)])
    client = client_for_room(settings, room, user)
    query = {"room_id": str(room.pk), "livekit_room_sid": "RM_delayed"}
    response = client.get(URL, query)
    assert response.status_code == 200
    assert response.json() == {
        "ready": False,
        "interpretation": False,
        "translation": False,
    }
    assert "no-store" in response["Cache-Control"]
    assert not models.MeetingSession.objects.filter(room=room).exists()

    session = MeetingSessionFactory(room=room, livekit_room_sid="RM_delayed")
    assert client.get(URL, query).json() == {
        "ready": True,
        "interpretation": True,
        "translation": True,
    }
    session.status = "ended"
    session.ended_at = timezone.now()
    session.end_reason = "room_finished"
    session.save()
    assert client.get(URL, query).json() == {
        "ready": False,
        "interpretation": False,
        "translation": False,
    }


def test_participation_webhook_enables_only_interpretation(settings):
    user = UserFactory()
    session = MeetingSessionFactory()
    query = {
        "room_id": str(session.room_id),
        "livekit_room_sid": session.livekit_room_sid,
    }
    client = client_for_room(settings, session.room, user)
    assert client.get(URL, query).json() == {
        "ready": True,
        "interpretation": False,
        "translation": False,
    }
    MeetingParticipationFactory(session=session, user=user, identity=user.sub)
    assert client.get(URL, query).json() == {
        "ready": True,
        "interpretation": True,
        "translation": False,
    }
    assert client_for_room(settings, session.room).get(URL, query).json() == {
        "ready": True,
        "interpretation": False,
        "translation": False,
    }


def test_requires_a_join_grant_for_the_exact_room_and_never_resolves_an_old_sid(
    settings,
):
    session = MeetingSessionFactory()
    query = {
        "room_id": str(session.room_id),
        "livekit_room_sid": session.livekit_room_sid,
    }
    assert APIClient().get(URL, query).status_code == 403
    assert client_for_room(settings, RoomFactory()).get(URL, query).status_code == 403
    assert (
        client_for_room(settings, session.room, can_join=False)
        .get(URL, query)
        .status_code
        == 403
    )
    response = client_for_room(settings, session.room).get(
        URL, {**query, "livekit_room_sid": "RM_unknown"}
    )
    assert response.status_code == 200
    assert response.json() == {
        "ready": False,
        "interpretation": False,
        "translation": False,
    }
