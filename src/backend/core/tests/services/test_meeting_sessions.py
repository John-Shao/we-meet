"""Tests for the MeetingSession lifecycle projector."""

from datetime import timedelta

from django.core.exceptions import ValidationError
from django.utils import timezone

import pytest
from livekit import api

from core import models
from core.factories import MeetingSessionFactory, RoomFactory, UserFactory
from core.services.meeting_sessions import (
    MeetingSessionRoomMismatch,
    MeetingSessionService,
)

pytestmark = pytest.mark.django_db


def _livekit_room(room, sid, started_at):
    return api.Room(
        name=str(room.id),
        sid=sid,
        creation_time=int(started_at.timestamp()),
    )


def _participant(sid="PA_one", identity="user-one", joined_at=None):
    joined_at = joined_at or timezone.now()
    return api.ParticipantInfo(
        sid=sid,
        identity=identity,
        name="User One",
        kind=api.ParticipantInfo.STANDARD,
        joined_at=int(joined_at.timestamp()),
    )


def test_start_is_idempotent_and_uses_livekit_creation_time():
    room = RoomFactory()
    started_at = timezone.now().replace(microsecond=0) - timedelta(minutes=2)
    livekit_room = _livekit_room(room, "RM_one", started_at)
    service = MeetingSessionService()

    first, first_created = service.start_from_livekit_room(
        room=room, livekit_room=livekit_room, event_at=started_at + timedelta(seconds=3)
    )
    second, second_created = service.start_from_livekit_room(
        room=room, livekit_room=livekit_room, event_at=started_at + timedelta(seconds=5)
    )

    assert first_created is True
    assert second_created is False
    assert second.id == first.id
    assert second.started_at == started_at
    assert second.start_source == models.MeetingSession.StartSource.LIVEKIT_ROOM
    assert second.last_event_at == started_at + timedelta(seconds=5)
    assert models.MeetingSession.objects.count() == 1


def test_newer_sid_supersedes_active_session_and_closes_open_participation():
    room = RoomFactory()
    first_start = timezone.now().replace(microsecond=0) - timedelta(hours=1)
    old = MeetingSessionFactory(
        room=room,
        livekit_room_sid="RM_old",
        started_at=first_start,
    )
    participation = models.MeetingParticipation.objects.create(
        session=old,
        livekit_participant_sid="PA_old",
        identity="old-user",
        joined_at=first_start + timedelta(minutes=1),
    )
    new_start = first_start + timedelta(minutes=30)

    new, created = MeetingSessionService().start_from_livekit_room(
        room=room,
        livekit_room=_livekit_room(room, "RM_new", new_start),
        event_at=new_start,
    )

    old.refresh_from_db()
    participation.refresh_from_db()
    assert created is True
    assert new.status == models.MeetingSession.Status.ACTIVE
    assert old.status == models.MeetingSession.Status.ENDED
    assert old.end_reason == models.MeetingSession.EndReason.SUPERSEDED
    assert old.ended_at == new_start
    assert participation.left_at == new_start


def test_late_older_sid_does_not_supersede_newer_active_session():
    room = RoomFactory()
    active_start = timezone.now().replace(microsecond=0)
    active = MeetingSessionFactory(
        room=room,
        livekit_room_sid="RM_current",
        started_at=active_start,
    )
    old_start = active_start - timedelta(hours=1)

    recovered, created = MeetingSessionService().start_from_livekit_room(
        room=room,
        livekit_room=_livekit_room(room, "RM_late_old", old_start),
        event_at=active_start + timedelta(minutes=1),
    )

    active.refresh_from_db()
    assert created is True
    assert active.status == models.MeetingSession.Status.ACTIVE
    assert recovered.status == models.MeetingSession.Status.ENDED
    assert recovered.end_reason == models.MeetingSession.EndReason.SUPERSEDED
    assert recovered.ended_at == active_start


def test_room_sid_cannot_move_between_rooms():
    first_room = RoomFactory()
    second_room = RoomFactory()
    started_at = timezone.now().replace(microsecond=0)
    service = MeetingSessionService()
    service.start_from_livekit_room(
        room=first_room,
        livekit_room=_livekit_room(first_room, "RM_shared", started_at),
        event_at=started_at,
    )

    with pytest.raises(MeetingSessionRoomMismatch):
        service.start_from_livekit_room(
            room=second_room,
            livekit_room=_livekit_room(second_room, "RM_shared", started_at),
            event_at=started_at,
        )


def test_join_and_leave_are_idempotent_and_resolve_registered_user():
    user = UserFactory(sub="user-one")
    session = MeetingSessionFactory()
    joined_at = session.started_at + timedelta(seconds=10)
    left_at = joined_at + timedelta(minutes=5)
    participant = _participant(joined_at=joined_at)
    service = MeetingSessionService()

    first = service.record_participant_join(
        session=session, participant=participant, event_at=joined_at
    )
    second = service.record_participant_join(
        session=session, participant=participant, event_at=joined_at
    )
    participant.disconnect_reason = api.DisconnectReason.CLIENT_INITIATED
    closed = service.record_participant_left(
        session=session, participant=participant, event_at=left_at
    )
    duplicate = service.record_participant_left(
        session=session, participant=participant, event_at=left_at
    )

    assert first.id == second.id == closed.id == duplicate.id
    assert duplicate.user == user
    assert duplicate.kind == "standard"
    assert duplicate.left_at == left_at
    assert duplicate.disconnect_reason == "client_initiated"
    assert models.MeetingParticipation.objects.count() == 1


def test_left_without_join_recovers_a_closed_interval():
    session = MeetingSessionFactory()
    joined_at = session.started_at + timedelta(seconds=5)
    left_at = joined_at + timedelta(minutes=1)
    participant = _participant(joined_at=joined_at)

    participation = MeetingSessionService().record_participant_left(
        session=session, participant=participant, event_at=left_at
    )

    assert participation.joined_at == joined_at.replace(microsecond=0)
    assert participation.left_at == left_at


def test_late_left_event_corrects_finish_inferred_leave_time():
    session = MeetingSessionFactory()
    joined_at = session.started_at + timedelta(seconds=5)
    actual_left_at = joined_at + timedelta(minutes=1)
    finished_at = actual_left_at + timedelta(minutes=2)
    participant = _participant(joined_at=joined_at)
    service = MeetingSessionService()
    participation = service.record_participant_join(
        session=session, participant=participant, event_at=joined_at
    )
    service.finish(
        session=session,
        ended_at=finished_at,
        reason=models.MeetingSession.EndReason.ROOM_FINISHED,
        event_at=finished_at,
    )

    participation.refresh_from_db()
    assert participation.left_at == finished_at

    participant.disconnect_reason = api.DisconnectReason.CLIENT_INITIATED
    participation = service.record_participant_left(
        session=session,
        participant=participant,
        event_at=actual_left_at,
    )

    assert participation.left_at == actual_left_at
    assert participation.disconnect_reason == "client_initiated"


def test_finish_is_idempotent_and_requires_consistent_model_state():
    session = MeetingSessionFactory()
    ended_at = session.started_at + timedelta(minutes=10)
    service = MeetingSessionService()

    ended, first_changed = service.finish(
        session=session,
        ended_at=ended_at,
        reason=models.MeetingSession.EndReason.ROOM_FINISHED,
        event_at=ended_at,
    )
    duplicate, second_changed = service.finish(
        session=ended,
        ended_at=ended_at,
        reason=models.MeetingSession.EndReason.ROOM_FINISHED,
        event_at=ended_at,
    )

    assert first_changed is True
    assert second_changed is False
    assert duplicate.ended_at == ended_at

    invalid = models.MeetingSession(
        room=RoomFactory(),
        livekit_room_sid="RM_invalid",
        started_at=timezone.now(),
        status=models.MeetingSession.Status.ENDED,
        ended_at=None,
        end_reason=models.MeetingSession.EndReason.ROOM_FINISHED,
        start_source=models.MeetingSession.StartSource.LIVEKIT_ROOM,
    )
    with pytest.raises(ValidationError):
        invalid.full_clean()
