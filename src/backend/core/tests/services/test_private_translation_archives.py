"""Private archives remain owner-only even inside a shared meeting note."""

import uuid
from datetime import timedelta

from django.utils import timezone

import pytest

from core import models
from core.factories import MeetingParticipationFactory, UserFactory
from core.services import meeting_translation as service
from core.services import translation_archives as archives
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_translation import (
    enabled,
    fixture,
    payload,
    receipt,
    start,
    worker,
)
from core.tests.test_api_agent_internal import TOKEN, _client

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def retained(settings, enabled):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_TRANSLATION_ARCHIVE_ENABLED = True


def setup(mode="simultaneous"):
    user, session, source = fixture()
    source.livekit_participant_sid = "PA_private"
    source.save(update_fields=["livekit_participant_sid"])
    _, run, _ = start(user, session, source, save_translations=True, mode=mode)
    data = worker(session, run)
    service.agent_control(run.pk, data)
    data.pop("operation")
    data.update(
        source_participation_id=source.pk,
        source_participant_sid=source.livekit_participant_sid,
        response_id="response-1",
        item_id="item-1",
        direction="forward",
        text="Confirmed plan",
    )
    archive = models.MeetingTranslationArchive.objects.get(source_id=run.pk)
    return user, session, source, run, archive, data


def append(run, data):
    return archives.append_segment(run.pk, data, source_kind="private")


def test_private_retention_is_explicit_and_feature_gated(settings):
    user, session, source = fixture()
    settings.MEETING_TRANSLATION_ARCHIVE_ENABLED = False
    with pytest.raises(RecordConflict):
        start(user, session, source, save_translations=True)
    assert not models.MeetingRecord.objects.exists()
    start(user, session, source)
    assert not models.MeetingTranslationArchive.objects.exists()


def test_original_intent_replay_keeps_one_archive_and_record():
    user, session, source = fixture()
    key = uuid.uuid4()
    value = payload(source, save_translations=True)
    first = service.control(session.pk, user, key, value)[0]
    repeated = service.control(session.pk, user, key, value)
    assert repeated[0] == first and repeated[2]
    assert models.MeetingTranslationArchive.objects.count() == 1
    assert models.MeetingRecord.objects.count() == 1
    with pytest.raises(RecordConflict):
        service.control(session.pk, user, key, {**value, "save_translations": False})


def test_bidirectional_items_keep_distinct_language_and_receipts():
    _, _, _, run, archive, data = setup("push_to_talk")
    first = append(run, data)
    reverse = append(run, {**data, "direction": "reverse", "text": "确认计划"})
    assert first["run_id"] == str(run.pk) and first["record_id"] == str(
        archive.record_id
    )
    assert first["sequence"] == 1 and reverse["sequence"] == 2
    assert append(run, data)["replayed"]
    assert list(
        archive.segments.order_by("sequence").values_list("direction", "target")
    ) == [("forward", "en"), ("reverse", "zh")]
    assert not models.Transcript.objects.exists()
    with pytest.raises(RecordConflict):
        append(run, {**data, "text": "Cannot replace a confirmed item"})


@pytest.mark.parametrize(
    "field,value",
    [
        ("direction", "reverse"),
        ("worker_id", uuid.uuid4()),
        ("generation", 2),
        ("source_participation_id", uuid.uuid4()),
        ("source_participant_sid", "PA_other"),
        ("livekit_room_sid", "RM_other"),
    ],
)
def test_private_writer_and_direction_fences(field, value):
    _, _, _, run, archive, data = setup()
    with pytest.raises(RecordConflict):
        append(run, {**data, field: value})
    assert not archive.segments.exists()


def test_another_human_in_same_meeting_cannot_become_private_source():
    _, session, _, run, _, data = setup()
    other = MeetingParticipationFactory(session=session, user=UserFactory())
    with pytest.raises(RecordConflict):
        append(
            run,
            {
                **data,
                "source_participation_id": other.pk,
                "source_participant_sid": other.livekit_participant_sid,
            },
        )


@pytest.mark.parametrize(
    "archive_finished,status",
    [(True, "complete"), (False, "incomplete"), (None, "incomplete")],
)
def test_private_tail_and_independent_archive_completion(archive_finished, status):
    user, session, _, run, archive, data = setup()
    service.control(
        session.pk,
        user,
        uuid.uuid4(),
        {"operation": "stop", "expected_run_id": str(run.pk)},
    )
    append(run, data)
    final = receipt(
        **(
            {"archive_finished": archive_finished}
            if archive_finished is not None
            else {}
        )
    )
    service.agent_control(run.pk, {**data, "operation": "finish", "receipt": final})
    archive.refresh_from_db()
    assert archive.status == status
    assert append(run, data)["replayed"]
    with pytest.raises(RecordConflict):
        append(run, {**data, "item_id": "after-finish"})


def test_private_permission_revocation_blocks_new_items_but_not_original_receipt(
    settings,
):
    _, _, source, run, archive, data = setup()
    append(run, data)
    source.left_at = timezone.now()
    source.save(update_fields=["left_at"])
    with pytest.raises(RecordConflict):
        append(run, {**data, "item_id": "after-leave"})
    settings.MEETING_TRANSLATION_ENABLED = False
    assert append(run, data)["replayed"]
    assert archive.segments.count() == 1


@pytest.mark.parametrize("cause", ["timeout", "delete"])
def test_orphaned_private_archives_become_incomplete(cause):
    _, _, _, run, archive, data = setup()
    append(run, data)
    if cause == "delete":
        run.delete()
    else:
        models.MeetingTranslationRun.objects.filter(pk=run.pk).update(
            heartbeat_at=timezone.now() - timedelta(seconds=31)
        )
        service.agent_control(run.pk, {**data, "operation": "heartbeat"})
    archive.refresh_from_db()
    assert archive.status == "incomplete" and archive.segments.count() == 1


def test_only_owner_with_current_original_access_can_read_private_archive():
    user, session, _, run, archive, data = setup()
    append(run, data)
    other = UserFactory()
    models.ResourceAccess.objects.create(
        resource=session.room, user=other, role="owner"
    )
    listing = f"/api/v1.0/meeting-records/{archive.record_id}/translation-archives/"
    detail = f"/api/v1.0/meeting-records/{archive.record_id}/translation-segments/?archive_id={archive.pk}"
    assert client_for(other).get(listing).json()["results"] == []
    assert client_for(other).get(detail).status_code == 404
    assert client_for(user).get(detail).json()["results"][0]["text"] == data["text"]
    models.ResourceAccess.objects.filter(resource=session.room, user=user).delete()
    assert client_for(user).get(detail).status_code == 404


def test_private_ingest_requires_worker_token_and_rejects_unknown_fields(settings):
    _, _, _, run, archive, data = setup()
    client = _client(settings)
    client.credentials(HTTP_X_AGENT_TOKEN=TOKEN)
    endpoint = "/api/agent/translations/segments/"
    assert client.post(endpoint, data, format="json").status_code == 200
    assert (
        client
        .post(endpoint, {**data, "channel_id": str(run.pk)}, format="json")
        .status_code
        == 400
    )
    assert client_for(UserFactory()).post(
        endpoint, data, format="json"
    ).status_code in (401, 403)
    assert archive.segments.count() == 1


def test_disabling_translation_revokes_existing_private_worker_tail(settings):
    _, _, _, run, _, data = setup()
    settings.MEETING_TRANSLATION_ENABLED = False
    result = service.agent_control(run.pk, {**data, "operation": "heartbeat"})
    assert result == {"state": "stopping"}
