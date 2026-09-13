"""Growing audio input has stable receipts and no premature original publication."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import capture_transcription as service
from core.services.capture_live_inputs import inputs
from core.tests.services.test_capture_audio import recording, seal, upload
from core.tests.services.test_capture_transcription import (
    agent,
    claim,
    control,
    enabled,
    final,
    finish,
)
from core.tests.services.test_meeting_captures import ROOT, command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def live_enabled(settings, enabled):
    settings.MEETING_CAPTURE_LIVE_ASR_ENABLED = True


def request(user, capture, key=None, expected=None):
    return client_for(user).post(
        f"{ROOT}{capture.pk}/transcription/",
        {"expected_job_id": str(expected) if expected else None, "live": True},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def running():
    user, body, capture = recording()
    assert request(user, capture).status_code == 201
    worker = uuid.uuid4()
    response = agent(
        "claim/",
        {
            "worker_id": str(worker),
            "model": "qwen-audio-3.0-asr-flash-streaming",
            "region": "cn-beijing",
            "live": True,
        },
    )
    job = response.data["job"]
    assert job["mode"] == "live" and job["input_count"] == 0
    assert control(job["id"], worker, "begin").status_code == 200
    return user, body, capture, worker, job


def poll(job, worker, after=0):
    return control(job["id"], worker, "poll_inputs", after_index=after)


def preview(user, capture, job, after=0):
    return client_for(user).get(
        f"{ROOT}{capture.pk}/transcription/{job['id']}/preview/?after_sequence={after}"
    )


def test_live_start_requires_open_capture_and_explicit_flag(settings):
    user, _, capture = recording()
    settings.MEETING_CAPTURE_LIVE_ASR_ENABLED = False
    assert request(user, capture).status_code == 409
    assert not models.CaptureTranscriptionJob.objects.exists()


def test_legacy_workers_cannot_claim_live_attempts_and_original_intent_replays():
    user, _, capture = recording()
    key = uuid.uuid4()
    first = request(user, capture, key)
    second = request(user, capture, key)
    assert first.status_code == 201 and second.status_code == 200
    assert first.data["job"]["id"] == second.data["job"]["id"]
    assert claim()[1] is None
    assert models.CaptureTranscriptionJob.objects.count() == 1


def test_live_inputs_wait_for_missing_sequence_and_offer_each_identity_once():
    user, body, capture, worker, job = running()
    assert upload(user, body, capture, sequence=2, start_ms=1000).status_code == 200
    assert poll(job, worker).data["feed"]["entries"] == []
    assert upload(user, body, capture).status_code == 200
    first = poll(job, worker).data["feed"]
    second = poll(job, worker).data["feed"]
    assert first == second
    assert [row["index"] for row in first["entries"]] == [1, 2]
    assert models.CaptureTranscriptionInput.objects.count() == 2
    assert not first["closed"]
    assert poll(job, worker, 3).status_code == 409


def test_pause_keeps_source_offsets_and_does_not_close_the_input():
    user, body, capture, worker, job = running()
    upload(user, body, capture)
    poll(job, worker)
    command(user, body, capture, "pause")
    paused = poll(job, worker, 1).data["feed"]
    assert paused["capture_status"] == "paused" and not paused["closed"]
    command(user, body, capture, "resume")
    upload(user, body, capture, sequence=2, start_ms=5000)
    resumed = poll(job, worker, 1).data["feed"]
    assert resumed["entries"][0]["chunk"]["start_ms"] == 5000
    model = models.CaptureTranscriptionJob.objects.get(pk=job["id"])
    assert inputs(model)["runs"] == 2
    assert model.inputs["chunks"] == []


def test_live_final_preview_is_owner_only_and_not_formal_originals():
    user, body, capture, worker, job = running()
    upload(user, body, capture)
    poll(job, worker)
    assert final(job["id"], worker)[0].status_code == 201
    response = preview(user, capture, job)
    assert response.status_code == 200 and not response.data["published"]
    assert response.data["results"][0]["text"] == "Confirm the release date."
    assert response["Cache-Control"] == "private, no-store"
    assert not service.current_originals(capture.record).exists()
    assert preview(UserFactory(), capture, job).status_code in (403, 404)
    user.is_active = False
    user.save(update_fields=["is_active"])
    assert preview(user, capture, job).status_code in (401, 403, 404)


def test_offer_is_required_before_audio_and_final_ingestion():
    user, body, capture, worker, job = running()
    upload(user, body, capture)
    assert final(job["id"], worker)[0].status_code == 409
    assert (
        control(job["id"], worker, "ack_input", index=1, checksum="a" * 64).status_code
        == 409
    )
    assert poll(job, uuid.uuid4()).status_code == 409
    assert not models.CaptureTranscriptionInput.objects.exists()


def test_early_finish_cannot_publish_while_recording_is_open():
    user, body, capture, worker, job = running()
    upload(user, body, capture)
    feed = poll(job, worker).data["feed"]
    control(
        job["id"],
        worker,
        "ack_input",
        index=1,
        checksum=feed["entries"][0]["chunk"]["checksum"],
    )
    final(job["id"], worker)
    assert finish(job["id"], worker).data["status"] == "incomplete"
    capture.refresh_from_db()
    assert capture.active_transcription_id is None


def test_sealed_receipts_publish_exactly_one_complete_generation():
    user, body, capture, worker, job = running()
    upload(user, body, capture)
    feed = poll(job, worker).data["feed"]
    control(
        job["id"],
        worker,
        "ack_input",
        index=1,
        checksum=feed["entries"][0]["chunk"]["checksum"],
    )
    final(job["id"], worker)
    command(user, body, capture, "stop")
    seal(user, body, capture)
    command(user, body, capture, "finalize")
    assert poll(job, worker, 1).data["feed"]["closed"]
    task = uuid.uuid4()
    assert finish(job["id"], worker, task=task).data["status"] == "succeeded"
    capture.refresh_from_db()
    revision = capture.record.revision
    assert str(capture.active_transcription_id) == job["id"]
    assert preview(user, capture, job).data["published"]
    assert service.current_originals(capture.record).count() == 1
    assert finish(job["id"], worker, task=task).status_code == 200
    capture.record.refresh_from_db()
    assert capture.record.revision == revision


def test_sealing_missing_audio_explicitly_exposes_the_gap_without_waiting_forever():
    user, body, capture, worker, job = running()
    upload(user, body, capture, sequence=2, start_ms=1000)
    command(user, body, capture, "stop")
    seal(user, body, capture, 2)
    feed = poll(job, worker).data["feed"]
    assert feed["closed"]
    assert feed["manifest"]["outcome"] == "incomplete"
    assert feed["manifest"]["missing_sequences"] == [1]
    assert feed["entries"][0]["chunk"]["sequence"] == 2


@pytest.mark.parametrize("cause", ["flag", "lease", "cancel"])
def test_live_permission_and_execution_end_do_not_stop_original_recording(
    settings, cause
):
    user, _, capture, worker, job = running()
    if cause == "flag":
        settings.MEETING_CAPTURE_LIVE_ASR_ENABLED = False
    elif cause == "lease":
        models.CaptureTranscriptionJob.objects.filter(pk=job["id"]).update(
            lease_until=timezone.now() - timedelta(seconds=1)
        )
    else:
        service.cancel(job["id"], user)
    assert poll(job, worker).status_code == 409
    capture.refresh_from_db()
    assert capture.status == "recording"


def test_live_input_and_closed_manifest_are_immutable():
    user, body, capture, worker, job = running()
    upload(user, body, capture)
    poll(job, worker)
    offered = models.CaptureTranscriptionInput.objects.get()
    offered.snapshot = {**offered.snapshot, "checksum": "b" * 64}
    with pytest.raises(ValidationError):
        offered.save()
    command(user, body, capture, "stop")
    seal(user, body, capture)
    poll(job, worker)
    run = models.CaptureTranscriptionJob.objects.get(pk=job["id"])
    run.live_manifest = {"outcome": "invented"}
    with pytest.raises(ValidationError):
        run.save()


def test_input_pages_are_bounded_and_cursor_replay_keeps_the_same_first_page():
    _, _, capture, worker, job = running()
    models.CaptureAudioChunk.objects.bulk_create(
        [
            models.CaptureAudioChunk(
                capture=capture,
                sequence=index,
                start_ms=(index - 1) * 1000,
                duration_ms=1000,
                checksum="a" * 64,
                byte_size=32044,
                stored=True,
                object_key=f"isolated/{index}.wav",
            )
            for index in range(1, 52)
        ]
    )
    first = poll(job, worker).data["feed"]
    assert len(first["entries"]) == 50 and first["next_index"] == 50
    last = poll(job, worker, 50).data["feed"]
    assert [row["index"] for row in last["entries"]] == [51]
    assert poll(job, worker).data["feed"]["entries"] == first["entries"]
    assert models.CaptureTranscriptionInput.objects.count() == 51


@pytest.mark.django_db(transaction=True)
def test_concurrent_poll_reuses_one_ordered_input_ledger():
    user, body, capture, worker, job = running()
    upload(user, body, capture)

    def execute(_):
        close_old_connections()
        try:
            return service.control(
                job["id"], worker, "poll_inputs", {"after_index": 0}
            )["feed"]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(execute, range(2)))
    assert replies[0] == replies[1]
    assert models.CaptureTranscriptionInput.objects.count() == 1
