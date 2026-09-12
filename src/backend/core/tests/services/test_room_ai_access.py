"""A current material grant is required before and after model output is produced."""

from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.conf import settings
from django.contrib.auth.models import AnonymousUser

import pytest
from livekit.api import AccessToken, VideoGrants
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient

from core import models
from core.factories import MeetingSessionFactory, RoomFactory, UserFactory
from core.services.meeting_records import ensure_online_record
from core.services.room_ai import RoomAIService
from core.services.room_ai_access import authorized_session, guard_stream

pytestmark = pytest.mark.django_db


def setup():
    user = UserFactory()
    room = RoomFactory(users=[(user, models.RoleChoices.OWNER)])
    session = MeetingSessionFactory(room=room)
    ensure_online_record(session, allow_empty=True)
    return user, room, session


def test_current_session_never_collects_historical_or_unscoped_transcripts():
    _, room, session = setup()
    old = MeetingSessionFactory(
        room=room,
        status="ended",
        started_at=session.started_at - timedelta(hours=1),
        ended_at=session.started_at,
        end_reason="room_finished",
    )
    for source, text in [
        (session, "Current"),
        (old, "Old secret"),
        (None, "Unscoped secret"),
    ]:
        models.Transcript.objects.create(
            room=room,
            session=source,
            text=text,
            speaker_identity="speaker",
            started_at=session.started_at,
        )
    llm = MagicMock()
    llm.chat.return_value = "Current"
    service = RoomAIService(llm=llm)
    result = service.ask(room=room, session_id=session.pk, question="What happened?")
    assert result["transcripts_used"] == 1
    system = llm.chat.call_args.kwargs["system"]
    assert (
        "Current" in system
        and "Old secret" not in system
        and "Unscoped secret" not in system
    )
    assert service._collect_recent(room, session_id=old.pk) == []


def test_guest_attendee_and_revoked_reader_cannot_read_materials():
    user, room, session = setup()
    assert authorized_session(room, user).pk == session.pk
    for outsider in (AnonymousUser(), UserFactory()):
        with pytest.raises(PermissionDenied):
            authorized_session(room, outsider)
    room.accesses.filter(user=user).delete()
    with pytest.raises(PermissionDenied):
        authorized_session(room, user)


def test_stream_rechecks_grant_after_the_provider_returns_before_releasing_text():
    user, room, session = setup()
    closed = []

    def provider():
        try:
            yield {"type": "meta"}
            room.accesses.filter(user=user).delete()
            yield {"type": "delta", "text": "Must not escape"}
        finally:
            closed.append(True)

    stream = guard_stream(provider(), room, user, session.pk)
    assert next(stream) == {"type": "meta"}
    with pytest.raises(PermissionDenied):
        next(stream)
    assert closed == [True]


def test_room_api_rejects_join_only_identity_and_checks_access_after_generation():
    user, room, _ = setup()

    def token(identity):
        return (
            AccessToken(
                api_key=settings.LIVEKIT_CONFIGURATION["api_key"],
                api_secret=settings.LIVEKIT_CONFIGURATION["api_secret"],
            )
            .with_grants(VideoGrants(room=str(room.pk), room_join=True))
            .with_identity(identity)
            .to_jwt()
        )

    client = APIClient()
    url = f"/api/v1.0/rooms/{room.pk}/ask-ai/"
    with patch("core.services.room_ai.RoomAIService.ask") as call:
        result = client.post(
            url,
            {"question": "Hello"},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {token('guest')}",
        )
        assert result.status_code == 403
        call.assert_not_called()

        def revoke(**kwargs):
            room.accesses.filter(user=user).delete()
            return {"answer": "Secret provider output"}

        call.side_effect = revoke
        result = client.post(
            url,
            {"question": "Hello"},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {token(user.sub)}",
        )
        assert result.status_code == 403
        assert "Secret provider output" not in str(result.data)
