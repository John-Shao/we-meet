"""Retained translation identity, durable receipts, bounds and original-material ACLs."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.services import interpretation_workers as workers
from core.services import meeting_interpretation as channels
from core.services import translation_archives as archives
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_interpretation import fixture, join, start
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_INTERPRETATION_ENABLED = True
    settings.ROOM_INTERPRETATION_AGENT_NAME = "isolated-interpretation-worker"
    settings.CELERY_ENABLED = True
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_TRANSLATION_ARCHIVE_ENABLED = True


def setup():
    owner, peer, session, first, second = fixture()
    result, _ = channels.control(
        session.pk,
        owner,
        uuid.uuid4(),
        {
            "operation": "start",
            "target": "en",
            "expected_channel_id": None,
            "save_translations": True,
        },
    )
    channel = models.MeetingInterpretationChannel.objects.get(pk=result["id"])
    join(peer, second, channel)
    data = {
        "channel_id": channel.pk,
        "room_id": session.room_id,
        "livekit_room_sid": session.livekit_room_sid,
        "generation": channel.generation,
        "worker_id": uuid.uuid4(),
        "source_participation_id": first.pk,
        "source_participant_sid": first.livekit_participant_sid,
        "response_id": "response-1",
        "item_id": "item-1",
        "direction": "forward",
        "text": "We will confirm the release scope tomorrow.",
    }
    workers.agent_control(channel.pk, {**data, "operation": "claim"})
    archive = models.MeetingTranslationArchive.objects.get(source_id=channel.pk)
    return owner, peer, session, first, channel, archive, data


def test_retention_requires_an_explicit_choice_and_flag(settings):
    owner, _, session, _, _ = fixture()
    start(owner, session)
    assert not models.MeetingTranslationArchive.objects.exists()
    assert not models.MeetingRecord.objects.exists()
    settings.MEETING_TRANSLATION_ARCHIVE_ENABLED = False
    with pytest.raises(RecordConflict):
        channels.control(
            session.pk,
            owner,
            uuid.uuid4(),
            {
                "operation": "start",
                "target": "zh",
                "expected_channel_id": None,
                "save_translations": True,
            },
        )
    assert not models.MeetingRecord.objects.exists()


def test_opt_in_and_confirmed_items_keep_one_exact_record_without_original_writes():
    owner, _, session, _, channel, archive, data = setup()
    before_revision = archive.record.revision
    first = archives.append_segment(channel.pk, data)
    repeated = archives.append_segment(channel.pk, data)
    assert first["id"] == repeated["id"] and repeated["replayed"]
    archive.refresh_from_db()
    assert archive.segment_count == 1 and archive.text_bytes == len(
        data["text"].encode()
    )
    assert archive.record.revision == before_revision
    assert not models.Transcript.objects.exists()
    result, _ = channels.control(
        session.pk,
        owner,
        uuid.uuid4(),
        {
            "operation": "start",
            "target": "zh",
            "expected_channel_id": None,
            "save_translations": True,
        },
    )
    assert result["archive_record_id"] == str(archive.record_id)
    assert models.MeetingRecord.objects.count() == 1


def test_duplicate_identity_cannot_replace_confirmed_text():
    *_, channel, archive, data = setup()
    archives.append_segment(channel.pk, data)
    with pytest.raises(RecordConflict):
        archives.append_segment(channel.pk, {**data, "text": "A different decision"})
    assert archive.segments.get().text == data["text"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("worker_id", uuid.uuid4()),
        ("generation", 2),
        ("room_id", uuid.uuid4()),
        ("livekit_room_sid", "RM_other"),
        ("source_participation_id", uuid.uuid4()),
        ("source_participant_sid", "PA_other"),
        ("direction", "reverse"),
    ],
)
def test_foreign_writer_generation_and_speaker_are_rejected(field, value):
    *_, channel, archive, data = setup()
    with pytest.raises(RecordConflict):
        archives.append_segment(channel.pk, {**data, field: value})
    assert not archive.segments.exists()


def test_expired_worker_and_agent_source_cannot_append():
    _, _, _, source, channel, archive, data = setup()
    source.kind = "agent"
    source.save(update_fields=["kind"])
    with pytest.raises(RecordConflict):
        archives.append_segment(channel.pk, data)
    source.kind = "standard"
    source.save(update_fields=["kind"])
    channel.heartbeat_at = timezone.now() - timedelta(seconds=16)
    channel.save(update_fields=["heartbeat_at"])
    with pytest.raises(RecordConflict):
        archives.append_segment(channel.pk, data)
    assert not archive.segments.exists()


def test_archive_budget_fails_without_partial_counter_updates():
    *_, channel, archive, data = setup()
    archives.append_segment(channel.pk, data)
    with patch.object(archives, "MAX_SEGMENTS", 1), pytest.raises(RecordConflict):
        archives.append_segment(channel.pk, {**data, "item_id": "item-2"})
    archive.refresh_from_db()
    assert archive.segment_count == archive.segments.count() == 1


@pytest.mark.parametrize(
    "archive_finished,expected",
    [(True, "complete"), (False, "incomplete"), (None, "incomplete")],
)
def test_tail_storage_and_archive_completion_are_independent_of_audio_receipt(
    archive_finished, expected
):
    owner, _, session, source, channel, archive, data = setup()
    channels.control(
        session.pk,
        owner,
        uuid.uuid4(),
        {
            "operation": "stop",
            "target": "en",
            "expected_channel_id": str(channel.pk),
        },
    )
    source.left_at = timezone.now()
    source.save(update_fields=["left_at"])
    archives.append_segment(channel.pk, data)
    receipt = {
        "provider_finished": True,
        "consumer_finished": True,
        "input_tokens": None,
        "output_tokens": None,
    }
    if archive_finished is not None:
        receipt["archive_finished"] = archive_finished
    workers.agent_control(
        channel.pk, {**data, "operation": "finish", "receipt": receipt}
    )
    channel.refresh_from_db()
    archive.refresh_from_db()
    assert channel.state == "stopped" and archive.status == expected
    assert archives.append_segment(channel.pk, data)["replayed"]
    with pytest.raises(RecordConflict):
        archives.append_segment(channel.pk, {**data, "item_id": "after-finish"})


def test_revocation_blocks_new_items_but_exact_receipts_do_not_repeat_writes(settings):
    owner, _, session, _, channel, archive, data = setup()
    archives.append_segment(channel.pk, data)
    models.ResourceAccess.objects.filter(resource=session.room, user=owner).delete()
    settings.MEETING_TRANSLATION_ARCHIVE_ENABLED = False
    assert archives.append_segment(channel.pk, data)["replayed"]
    with pytest.raises(RecordConflict):
        archives.append_segment(channel.pk, {**data, "item_id": "new"})
    assert archive.segments.count() == 1


def test_attendance_and_summary_only_grants_do_not_expose_retained_translation():
    owner, peer, _, _, channel, archive, data = setup()
    archives.append_segment(channel.pk, data)
    path = f"/api/v1.0/meeting-records/{archive.record_id}/translation-archives/"
    segments = f"/api/v1.0/meeting-records/{archive.record_id}/translation-segments/?archive_id={archive.pk}"
    peer_client = client_for(peer)
    assert peer_client.get(path).status_code == 404
    access = models.MeetingRecordAccess.objects.create(
        record=archive.record, user=peer, read_summary=True, read_transcript=False
    )
    assert peer_client.get(segments).status_code == 404
    access.read_transcript = True
    access.save(update_fields=["read_transcript"])
    response = peer_client.get(segments)
    assert response.status_code == 200
    row = response.data["results"][0]
    assert row["text"] == data["text"] and row["timing_basis"] == "delivery"
    assert row["original_id"] is None and "no-store" in response["Cache-Control"]
    models.MeetingTranslationArchive.objects.create(
        record=archive.record,
        source_id=uuid.uuid4(),
        source_kind="private",
        owner=owner,
        generation=1,
        configuration={"target": "en"},
    )
    assert len(peer_client.get(path).data["results"]) == 1
    assert len(client_for(owner).get(path).data["results"]) == 2
    access.delete()
    assert peer_client.get(segments).status_code == 404


def test_internal_endpoint_needs_agent_secret_and_accepts_only_final_item_shape(
    settings,
):
    *_, channel, archive, data = setup()
    settings.AGENT_INTERNAL_API_TOKEN = str(uuid.uuid4())
    client = APIClient()
    path = "/api/agent/interpretation/segments/"
    assert client.post(path, data, format="json").status_code == 403
    assert (
        client.post(
            path,
            {**data, "candidate": True},
            format="json",
            HTTP_X_AGENT_TOKEN=settings.AGENT_INTERNAL_API_TOKEN,
        ).status_code
        == 400
    )
    response = client.post(
        path, data, format="json", HTTP_X_AGENT_TOKEN=settings.AGENT_INTERNAL_API_TOKEN
    )
    assert response.status_code == 200 and not response.data["replayed"]
    assert archive.segments.count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_items_share_one_sequence_and_byte_count():
    *_, channel, archive, data = setup()

    def deliver(_index):
        close_old_connections()
        try:
            return archives.append_segment(channel.pk, data)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(deliver, range(2)))
    assert results[0]["id"] == results[1]["id"]
    assert sorted(result["replayed"] for result in results) == [False, True]
    archive.refresh_from_db()
    assert archive.segment_count == archive.segments.count() == 1
    assert archive.text_bytes == len(data["text"].encode())


def test_pagination_is_archive_scoped_and_survives_live_channel_deletion():
    owner, _, _, _, channel, archive, data = setup()
    for index in range(51):
        archives.append_segment(channel.pk, {**data, "item_id": f"item-{index}"})
    path = f"/api/v1.0/meeting-records/{archive.record_id}/translation-segments/"
    client = client_for(owner)
    response = client.get(path, {"archive_id": str(archive.pk)})
    assert len(response.data["results"]) == 50
    following = client.get(
        path, {"archive_id": str(archive.pk), "cursor": response.data["next_cursor"]}
    )
    assert [row["sequence"] for row in following.data["results"]] == [51]
    assert client.get(path, {"archive_id": str(uuid.uuid4())}).status_code == 404
    assert (
        client.get(path, {"archive_id": str(archive.pk), "target": "zh"}).status_code
        == 400
    )
    channel.delete()
    archive.refresh_from_db()
    assert archive.status == "incomplete"
    assert archive.segments.count() == 51
    assert client.get(path, {"archive_id": str(archive.pk)}).status_code == 200
