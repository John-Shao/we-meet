"""Shared interpretation has exact channels and independent expiring listener choices."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import (
    MeetingParticipationFactory,
    MeetingSessionFactory,
    MembershipFactory,
    OrganizationFactory,
    RoomFactory,
    UserFactory,
)
from core.services import meeting_interpretation as service
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_INTERPRETATION_ENABLED = True
    settings.ROOM_INTERPRETATION_AGENT_NAME = "isolated-interpretation-worker"
    settings.CELERY_ENABLED = True


def fixture():
    owner, peer = UserFactory(), UserFactory()
    room = RoomFactory()
    models.ResourceAccess.objects.create(
        resource=room, user=owner, role=models.RoleChoices.OWNER
    )
    session = MeetingSessionFactory(room=room, status="active", ended_at=None)
    first = MeetingParticipationFactory(
        session=session, user=owner, kind="standard", left_at=None
    )
    second = MeetingParticipationFactory(
        session=session, user=peer, kind="standard", left_at=None
    )
    return owner, peer, session, first, second


def start(owner, session, target="en"):
    result, _ = service.control(
        session.pk,
        owner,
        uuid.uuid4(),
        {"operation": "start", "target": target, "expected_channel_id": None},
    )
    return models.MeetingInterpretationChannel.objects.get(pk=result["id"])


def join(user, connection, channel, revision=0, key=None):
    payload = {
        "operation": "join",
        "participation_id": str(connection.pk),
        "channel_id": str(channel.pk),
        "expected_revision": revision,
    }
    result, replay = service.subscribe(
        channel.session_id, user, key or uuid.uuid4(), payload
    )
    return result, replay, payload


def test_channels_are_shared_by_target_but_do_not_start_provider_work_before_listening():
    owner, _, session, _, _ = fixture()
    with patch("requests.request") as network:
        channel = start(owner, session)
        assert channel.state == "prepared" and channel.worker_id is None
        assert channel.configuration["scope"] == "meeting_channel"
        assert channel.configuration["source"] is None
        with pytest.raises(RecordConflict):
            service.control(
                session.pk,
                owner,
                uuid.uuid4(),
                {
                    "operation": "start",
                    "target": "en",
                    "expected_channel_id": str(channel.pk),
                },
            )
        assert start(owner, session, "zh").pk != channel.pk
        network.assert_not_called()
    assert not models.MeetingTranslationRun.objects.exists()


def test_actual_participant_can_listen_but_cannot_start_a_billable_channel():
    owner, peer, session, _, connection = fixture()
    with pytest.raises(PermissionError):
        start(peer, session)
    channel = start(owner, session)
    result, replay, _ = join(peer, connection, channel)
    assert result["active"] and result["revision"] == 1 and not replay
    row = models.MeetingInterpretationSubscription.objects.get(participation=connection)
    assert result["id"] == str(row.pk)
    assert 0 < result["remaining_lease_seconds"] <= 20
    row.active = False
    assert service.serialize_subscription(row)["remaining_lease_seconds"] == 0
    channel.refresh_from_db()
    assert channel.state == "starting"


def test_leaving_a_personal_subscription_never_stops_other_listeners():
    owner, peer, session, first, second = fixture()
    channel = start(owner, session)
    join(owner, first, channel)
    join(peer, second, channel)
    service.subscribe(
        session.pk,
        peer,
        uuid.uuid4(),
        {
            "operation": "leave",
            "participation_id": str(second.pk),
            "channel_id": str(channel.pk),
            "expected_revision": 1,
        },
    )
    channel.refresh_from_db()
    assert channel.state == "starting"
    grants = service.grants(channel)
    assert [row["participant_sid"] for row in grants["listeners"]] == [
        first.livekit_participant_sid
    ]


def test_switching_fences_old_renewal_and_replay_never_restores_previous_choice():
    owner, peer, session, _, second = fixture()
    english, chinese = start(owner, session), start(owner, session, "zh")
    key = uuid.uuid4()
    _, _, old = join(peer, second, english, key=key)
    join(peer, second, chinese, revision=1)
    with pytest.raises(RecordConflict):
        service.renew(session.pk, peer, second.pk, english.pk, 1)
    result, replay = service.subscribe(session.pk, peer, key, old)
    assert replay and result["channel_id"] == str(english.pk)
    current = models.MeetingInterpretationSubscription.objects.get(participation=second)
    assert current.channel_id == chinese.pk and current.revision == 2


def test_expired_lease_cannot_be_revived_by_an_old_heartbeat():
    owner, peer, session, _, second = fixture()
    channel = start(owner, session)
    join(peer, second, channel)
    models.MeetingInterpretationSubscription.objects.update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert service.grants(channel)["listeners"] == []
    with pytest.raises(RecordConflict):
        service.renew(session.pk, peer, second.pk, channel.pk, 1)
    result, _, _ = join(peer, second, channel, revision=1)
    assert result["revision"] == 2 and result["active"]


def test_reconnect_and_another_device_do_not_inherit_an_old_subscription():
    owner, peer, session, _, second = fixture()
    channel = start(owner, session)
    join(peer, second, channel)
    second.left_at = timezone.now()
    second.save(update_fields=["left_at"])
    fresh = MeetingParticipationFactory(
        session=session,
        user=peer,
        kind="standard",
        left_at=None,
        identity=second.identity,
    )
    assert service.grants(channel)["listeners"] == []
    with pytest.raises(RecordConflict):
        service.renew(session.pk, peer, fresh.pk, channel.pk, 1)
    assert not models.MeetingInterpretationSubscription.objects.filter(
        participation=fresh
    ).exists()


def test_wrong_session_connection_and_other_users_connection_are_rejected():
    owner, peer, session, first, _ = fixture()
    channel = start(owner, session)
    outsider = MeetingParticipationFactory(user=peer, kind="standard", left_at=None)
    for connection in [first, outsider]:
        with pytest.raises(PermissionError):
            join(peer, connection, channel)
    foreign_owner, _, foreign_session, _, _ = fixture()
    foreign = start(foreign_owner, foreign_session)
    with pytest.raises(RecordConflict):
        service.subscribe(
            session.pk,
            owner,
            uuid.uuid4(),
            {
                "operation": "join",
                "participation_id": str(first.pk),
                "channel_id": str(foreign.pk),
                "expected_revision": 0,
            },
        )


def test_agent_sources_exclude_bots_and_never_truncate_capacity_overflow():
    owner, peer, session, first, second = fixture()
    channel = start(owner, session)
    join(peer, second, channel)
    MeetingParticipationFactory(session=session, kind="agent", left_at=None)
    grants = service.grants(channel)
    assert {row["participation_id"] for row in grants["sources"]} == {
        str(first.pk),
        str(second.pk),
    }
    for _ in range(service.MAX_SOURCES - 1):
        MeetingParticipationFactory(session=session, kind="standard", left_at=None)
    with pytest.raises(RecordConflict):
        service.grants(channel)


def test_manager_revocation_ends_grants_but_listener_expiry_does_not_reassign_billing():
    owner, peer, session, _, second = fixture()
    channel = start(owner, session)
    join(peer, second, channel)
    models.ResourceAccess.objects.filter(resource=session.room, user=owner).delete()
    assert service.grants(channel) == {"sources": [], "listeners": [], "stop": True}
    channel.refresh_from_db()
    assert channel.requested_by_id == owner.pk


def test_org_departure_invalidates_existing_listener_and_prevents_renewal():
    owner, peer, session, _, second = fixture()
    org = OrganizationFactory()
    session.room.organization = org
    session.room.save(update_fields=["organization"])
    MembershipFactory(user=owner, organization=org)
    membership = MembershipFactory(user=peer, organization=org)
    channel = start(owner, session)
    join(peer, second, channel)
    membership.delete()
    assert service.grants(channel)["listeners"] == []
    with pytest.raises(PermissionError):
        service.renew(session.pk, peer, second.pk, channel.pk, 1)


def test_rollout_disabled_still_allows_leave_and_manager_stop(settings):
    owner, peer, session, _, second = fixture()
    channel = start(owner, session)
    join(peer, second, channel)
    settings.MEETING_INTERPRETATION_ENABLED = False
    service.subscribe(
        session.pk,
        peer,
        uuid.uuid4(),
        {
            "operation": "leave",
            "participation_id": str(second.pk),
            "channel_id": str(channel.pk),
            "expected_revision": 1,
        },
    )
    result, _ = service.control(
        session.pk,
        owner,
        uuid.uuid4(),
        {"operation": "stop", "target": "en", "expected_channel_id": str(channel.pk)},
    )
    assert result["state"] == "stopped"


def test_api_only_exposes_callers_connections_and_own_subscriptions():
    owner, peer, session, first, second = fixture()
    channel = start(owner, session)
    join(owner, first, channel)
    join(peer, second, channel)
    query = {
        "room_id": str(session.room_id),
        "livekit_room_sid": session.livekit_room_sid,
    }
    response = client_for(peer).get("/api/v1.0/meeting-interpretation/channels/", query)
    assert response.status_code == 200 and not response.data["can_control"]
    assert [row["id"] for row in response.data["connections"]] == [str(second.pk)]
    assert [row["participation_id"] for row in response.data["subscriptions"]] == [
        str(second.pk)
    ]
    assert "no-store" in response["Cache-Control"]
    assert (
        client_for(UserFactory())
        .get("/api/v1.0/meeting-interpretation/channels/", query)
        .status_code
        == 404
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_choices_accept_only_one_current_revision():
    owner, peer, session, _, second = fixture()
    english, chinese = start(owner, session), start(owner, session, "zh")

    def choose(channel):
        close_old_connections()
        try:
            join(peer, second, channel)
            return "accepted"
        except RecordConflict:
            return "conflict"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(choose, [english, chinese])) == ["accepted", "conflict"]
    assert models.MeetingInterpretationSubscription.objects.count() == 1
