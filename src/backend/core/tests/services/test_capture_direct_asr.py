"""Direct text receipts are device-bound, durable, idempotent and explicitly saved."""

import uuid
from datetime import timedelta

from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import capture_transcription as service
from core.services.capture_summary_source import source as summary_source
from core.services.effective_transcripts import originals
from core.tests.services.test_capture_audio import recording, seal, upload
from core.tests.services.test_capture_transcription import enabled
from core.tests.services.test_meeting_captures import command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def direct_enabled(settings, enabled):
    settings.MEETING_CAPTURE_LIVE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_DIRECT_ASR_ENABLED = True
    settings.DASHSCOPE_ASR_CLIENT_API_KEY = "dedicated-test-key"


def start(user, source, capture, key=None, expected=None, **extra):
    return client_for(user).post(
        f"/api/v1.0/capture-sessions/{capture.pk}/transcription/direct/",
        {"device_id": source["device_id"], "expected_job_id": expected, **extra},
        format="json",
        HTTP_X_CAPTURE_LEASE=source["lease_key"],
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def sync(user, source, capture, job, **extra):
    body = {
        "device_id": source["device_id"],
        "operation": "sync",
        "ranges": [{"start_ms": 0, "end_ms": 1000}],
        "finals": [],
        "final_sequence": 0,
        "complete": True,
        **extra,
    }
    return client_for(user).post(
        f"/api/v1.0/capture-sessions/{capture.pk}/transcription/direct/{job}/",
        body,
        format="json",
        HTTP_X_CAPTURE_LEASE=source["lease_key"],
    )


def final(sequence=1, **extra):
    return {
        "ingest_id": str(uuid.uuid4()),
        "sequence": sequence,
        "start_ms": 0,
        "end_ms": 900,
        "text": "Confirmed final.",
        "language": "en",
        **extra,
    }


def test_start_is_idempotent_and_never_claimed_by_cloud_workers():
    user, source, capture = recording()
    key = uuid.uuid4()
    first = start(user, source, capture, key)
    assert first.status_code == 201
    assert (
        start(user, source, capture, key).data["job"]["id"] == first.data["job"]["id"]
    )
    assert first.data["job"]["transport"] == "direct"
    assert (
        service.claim(key, "qwen-audio-3.1-asr-flash-streaming", "cn-beijing", True)
        is None
    )


def test_source_requires_owner_device_and_lease(settings):
    user, source, capture = recording()
    assert start(UserFactory(), source, capture).status_code == 404
    assert start(user, source, capture, device_id="other").status_code == 403
    assert (
        start(user, {**source, "lease_key": str(uuid.uuid4())}, capture).status_code
        == 403
    )
    settings.DASHSCOPE_ASR_CLIENT_API_KEY = ""
    assert start(user, source, capture).status_code == 403


def test_final_receipts_publish_only_on_explicit_save_and_retry_safely():
    user, source, capture = recording()
    job = start(user, source, capture).data["job"]["id"]
    row = final()
    assert (
        sync(user, source, capture, job, finals=[row], final_sequence=1).status_code
        == 200
    )
    assert (
        sync(user, source, capture, job, finals=[row], final_sequence=1).status_code
        == 200
    )
    assert models.MeetingOriginalSegment.objects.count() == 1
    assert originals(capture.record).count() == 0
    done = sync(user, source, capture, job, operation="finish", final_sequence=1)
    assert done.status_code == 200 and done.data["status"] == "succeeded"
    assert done.data["coverage_status"] == "partial"
    assert originals(capture.record).count() == 1
    assert (
        sync(
            user, source, capture, job, operation="finish", final_sequence=1
        ).status_code
        == 200
    )
    assert sync(user, source, capture, job, final_sequence=1).status_code == 200
    assert not models.AIUsageRecord.objects.exists()


def test_conflicts_rollback_text_and_progress():
    user, source, capture = recording()
    job = start(user, source, capture).data["job"]["id"]
    assert (
        sync(user, source, capture, job, finals=[final(end_ms=1100)]).status_code == 409
    )
    assert models.MeetingOriginalSegment.objects.count() == 0
    assert (
        sync(user, source, capture, job, finals=[final(sequence=2)]).status_code == 409
    )
    assert (
        sync(
            user, source, capture, job, operation="finish", final_sequence=1
        ).status_code
        == 409
    )
    assert sync(user, source, capture, job).status_code == 200
    assert sync(user, source, capture, job, ranges=[]).status_code == 409


def test_partial_text_can_be_saved_after_network_lease_expiry():
    user, source, capture = recording()
    job = start(user, source, capture).data["job"]["id"]
    models.CaptureTranscriptionJob.objects.filter(pk=job).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    assert service.state(capture.pk, user)["results"][0]["status"] == "incomplete"
    response = sync(
        user,
        source,
        capture,
        job,
        operation="finish",
        complete=False,
        finals=[final()],
        final_sequence=1,
    )
    assert response.status_code == 200 and response.data["status"] == "succeeded"
    assert response.data["error_code"] == "direct_audio_gap"
    assert originals(capture.record).count() == 1


def test_canceled_generation_cannot_be_replayed():
    user, source, capture = recording()
    job = start(user, source, capture).data["job"]["id"]
    service.cancel(job, user)
    assert sync(user, source, capture, job, finals=[final()]).status_code == 409
    assert models.MeetingOriginalSegment.objects.count() == 0


def test_saved_receipts_reject_changed_history_and_wrong_device():
    user, source, capture = recording()
    job = start(user, source, capture).data["job"]["id"]
    assert (
        sync(
            user,
            source,
            capture,
            job,
            operation="finish",
            finals=[final()],
            final_sequence=1,
        ).status_code
        == 200
    )
    assert (
        sync(
            user,
            source,
            capture,
            job,
            operation="finish",
            final_sequence=1,
            complete=False,
        ).status_code
        == 409
    )
    assert (
        sync(user, source, capture, job, device_id="another-device").status_code == 403
    )
    assert (
        sync(user, {**source, "lease_key": str(uuid.uuid4())}, capture, job).status_code
        == 403
    )
    assert originals(capture.record).count() == 1


def test_text_retention_cannot_publish_partial_direct_asr():
    user, source, capture = recording()
    capture.record.retention_mode = "text"
    capture.record.save(update_fields=["retention_mode"])
    assert not service.state(capture.pk, user)["direct_available"]
    assert start(user, source, capture).status_code == 403
    assert not models.CaptureTranscriptionJob.objects.exists()


def test_formal_direct_text_is_available_to_summary_with_partial_coverage(settings):
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    user, source, capture = recording()
    job = start(user, source, capture).data["job"]["id"]
    assert upload(user, source, capture).status_code == 200
    assert command(user, source, capture, "stop").status_code == 200
    assert seal(user, source, capture, 1).status_code == 200
    assert command(user, source, capture, "finalize").status_code == 200
    assert (
        sync(
            user,
            source,
            capture,
            job,
            operation="finish",
            finals=[final()],
            final_sequence=1,
        ).status_code
        == 200
    )
    capture.refresh_from_db()
    segments, delivery = summary_source(capture.record)
    assert [row["text"] for row in segments] == ["Confirmed final."]
    assert delivery["status"] == "incomplete"
    assert delivery["capture_transcriptions"][0]["coverage_status"] == "partial"
