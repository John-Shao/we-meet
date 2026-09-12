"""Translation cannot cross users, sources, generations or completion boundaries."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import MeetingParticipationFactory, UserFactory
from core.services import meeting_translation as service
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_online_capture import meeting, source
from core.tests.test_api_agent_internal import TOKEN, _client

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/meeting-translations/control/"
AGENT_URL = "/api/agent/translations/control/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_TRANSLATION_ENABLED = True
    settings.ROOM_TRANSLATION_AGENT_NAME = "translation-test"
    settings.CELERY_ENABLED = True
    with patch("core.services.meeting_translation._send_dispatch"):
        yield


def fixture():
    user, session = meeting()
    participant = MeetingParticipationFactory(session=session, user=user)
    return user, session, participant


def payload(participant, **overrides):
    return {
        "operation": "start",
        "expected_run_id": None,
        "source_participation_id": str(participant.pk),
        "source": "zh",
        "target": "en",
        "mode": "simultaneous",
        "audio": True,
        **overrides,
    }


def start(user, session, participant, **overrides):
    return service.control(
        session.pk, user, uuid.uuid4(), payload(participant, **overrides)
    )


def worker(session, run, **overrides):
    return {
        **source(session),
        "generation": run.generation,
        "run_id": str(run.pk),
        "worker_id": uuid.uuid4(),
        "operation": "claim",
        **overrides,
    }


def receipt(**overrides):
    return {
        "provider_finished": True,
        "consumer_finished": True,
        "input_tokens": 12,
        "output_tokens": 7,
        **overrides,
    }


def test_private_start_replay_and_no_record_side_effects():
    user, session, participant = fixture()
    key = uuid.uuid4()
    value = payload(participant)
    result, run, replay = service.control(session.pk, user, key, value)
    assert not replay and result["state"] == "starting"
    assert result["configuration"]["scope"] == "controller_only"
    identity = worker(session, run)
    claimed = service.agent_control(run.pk, identity)
    assert claimed["state"] == "translating"
    assert claimed["source_identity"] == participant.identity
    assert claimed["destination_identity"] == participant.identity
    original, current, replay = service.control(session.pk, user, key, value)
    assert replay and original == result and current.state == "translating"
    with pytest.raises(RecordConflict):
        service.control(session.pk, user, key, {**value, "audio": False})
    assert not models.MeetingRecord.objects.exists()
    assert not models.Transcript.objects.exists()
    assert not models.Recording.objects.exists()


def test_stopping_drains_then_switch_creates_generation():
    user, session, participant = fixture()
    _, run, _ = start(user, session, participant)
    identity = worker(session, run)
    service.agent_control(run.pk, identity)
    stopped = {"operation": "stop", "expected_run_id": str(run.pk)}
    assert (
        service.control(session.pk, user, uuid.uuid4(), stopped)[0]["state"]
        == "stopping"
    )
    with pytest.raises(RecordConflict):
        start(user, session, participant, expected_run_id=str(run.pk))
    assert service.agent_control(run.pk, {**identity, "operation": "heartbeat"}) == {
        "state": "stopping",
        "deliver_tail": True,
    }
    final = {**identity, "operation": "finish", "receipt": receipt()}
    assert service.agent_control(run.pk, final) == {"state": "stopped"}
    assert service.agent_control(run.pk, final) == {"state": "stopped"}
    with pytest.raises(RecordConflict):
        service.agent_control(run.pk, {**final, "receipt": receipt(output_tokens=8)})
    _, replacement, _ = start(
        user,
        session,
        participant,
        expected_run_id=str(run.pk),
        source="en",
        target="zh",
        mode="push_to_talk",
    )
    assert replacement.generation == 2
    assert replacement.pk != run.pk
    assert service.agent_control(run.pk, identity) == {"state": "stopped"}
    with pytest.raises(RecordConflict):
        service.control(session.pk, user, uuid.uuid4(), stopped)


@pytest.mark.parametrize("complete", [False, True])
def test_provider_and_consumer_both_required(complete):
    user, session, participant = fixture()
    _, run, _ = start(user, session, participant)
    identity = worker(session, run)
    service.agent_control(run.pk, identity)
    result = service.agent_control(
        run.pk,
        {
            **identity,
            "operation": "finish",
            "receipt": receipt(consumer_finished=complete),
        },
    )
    assert result["state"] == ("stopped" if complete else "incomplete")


def test_wrong_worker_session_or_generation_rejected():
    user, session, participant = fixture()
    _, run, _ = start(user, session, participant)
    identity = worker(session, run)
    service.agent_control(run.pk, identity)
    for overrides in (
        {"worker_id": uuid.uuid4()},
        {"generation": 2},
        {"livekit_room_sid": "RM_wrong"},
        {"room_id": str(uuid.uuid4())},
    ):
        with pytest.raises(RecordConflict):
            service.agent_control(run.pk, {**identity, **overrides})
    run.refresh_from_db()
    assert run.worker_id == identity["worker_id"]


@pytest.mark.parametrize(
    "change", ["left", "revoked", "organization", "agent", "deleted"]
)
def test_authorization_loss_stops_and_hides_destination(change):
    user, session, participant = fixture()
    _, run, _ = start(user, session, participant)
    identity = worker(session, run)
    service.agent_control(run.pk, identity)
    if change == "left":
        participant.left_at = timezone.now()
        participant.save()
    elif change == "revoked":
        models.ResourceAccess.objects.filter(
            resource_id=session.room_id, user=user
        ).delete()
    elif change == "organization":
        models.MeetingTranslationRun.objects.filter(pk=run.pk).update(
            organization_id_snapshot=uuid.uuid4()
        )
    elif change == "agent":
        participant.kind = "agent"
        participant.save()
    else:
        participant.delete()
    assert service.agent_control(run.pk, {**identity, "operation": "heartbeat"}) == {
        "state": "stopping"
    }


def test_timeout_cannot_be_renewed_or_finished_as_complete(settings):
    user, session, participant = fixture()
    _, run, _ = start(user, session, participant)
    identity = worker(session, run)
    service.agent_control(run.pk, identity)
    models.MeetingTranslationRun.objects.filter(pk=run.pk).update(
        heartbeat_at=timezone.now() - timedelta(seconds=31)
    )
    settings.MEETING_TRANSLATION_ENABLED = False
    assert service.agent_control(run.pk, {**identity, "operation": "heartbeat"}) == {
        "state": "incomplete"
    }
    assert service.agent_control(
        run.pk, {**identity, "operation": "finish", "receipt": receipt()}
    ) == {"state": "incomplete"}


def test_rollout_off_blocks_start_allows_active_drain(settings):
    user, session, participant = fixture()
    _, run, _ = start(user, session, participant)
    identity = worker(session, run)
    service.agent_control(run.pk, identity)
    settings.MEETING_TRANSLATION_ENABLED = False
    assert (
        service.agent_control(run.pk, {**identity, "operation": "heartbeat"})["state"]
        == "translating"
    )
    service.control(
        session.pk,
        user,
        uuid.uuid4(),
        {"operation": "stop", "expected_run_id": str(run.pk)},
    )
    assert (
        service.agent_control(
            run.pk, {**identity, "operation": "finish", "receipt": receipt()}
        )["state"]
        == "stopped"
    )
    with pytest.raises(RecordConflict):
        start(user, session, participant, expected_run_id=str(run.pk))


def test_public_and_internal_api_boundaries(settings):
    user, session, participant = fixture()
    client = client_for(user)
    status = client.get(URL, source(session)).json()
    assert status["available"] and status["current"] is None
    assert status["sources"][0]["id"] == str(participant.pk)
    body = {**source(session), **payload(participant), "key": str(uuid.uuid4())}
    outsider = UserFactory()
    assert client_for(outsider).get(URL, source(session)).status_code == 404
    assert client_for(outsider).post(URL, body, format="json").status_code == 404
    assert (
        client.post(URL, {**body, "destination": "other"}, format="json").status_code
        == 400
    )
    assert (
        client.post(
            URL, {**body, "source_participation_id": str(uuid.uuid4())}, format="json"
        ).status_code
        == 409
    )
    response = client.post(URL, body, format="json")
    assert response.status_code == 200
    assert "worker_id" not in response.json()["current"]
    run = models.MeetingTranslationRun.objects.get()
    identity = worker(session, run)
    assert client.post(AGENT_URL, identity, format="json").status_code == 403
    agent = _client(settings)
    assert (
        agent.post(
            AGENT_URL, identity, format="json", HTTP_X_AGENT_TOKEN=TOKEN
        ).status_code
        == 200
    )
    bad = {**identity, "operation": "finish", "receipt": receipt(audio="private")}
    assert (
        agent.post(AGENT_URL, bad, format="json", HTTP_X_AGENT_TOKEN=TOKEN).status_code
        == 400
    )


def test_other_persons_source_and_invalid_pair_cannot_start():
    user, session, participant = fixture()
    other = MeetingParticipationFactory(session=session, user=UserFactory())
    with pytest.raises(RecordConflict):
        start(user, session, other)
    for options in ({"source": "en"}, {"target": "yue"}, {"mode": "unknown"}):
        with pytest.raises(RecordConflict):
            start(user, session, participant, **options)
    assert not models.MeetingTranslationRun.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_start_has_one_winner():
    user, session, participant = fixture()
    barrier = Barrier(2)

    def attempt():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            start(user, session, participant)
            return "started"
        except RecordConflict:
            return "conflict"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: attempt(), range(2)))
    assert sorted(outcomes) == ["conflict", "started"]
    assert models.MeetingTranslationRun.objects.count() == 1


def test_unclaimed_run_expires_without_a_provider(settings):
    user, session, participant = fixture()
    _, run, _ = start(user, session, participant)
    models.MeetingTranslationRun.objects.filter(pk=run.pk).update(
        created_at=timezone.now() - timedelta(seconds=61)
    )
    settings.MEETING_TRANSLATION_ENABLED = False
    service.tick_translations()
    run.refresh_from_db()
    assert run.state == "incomplete" and run.worker_id is None
