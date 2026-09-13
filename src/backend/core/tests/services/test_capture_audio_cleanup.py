"""Durable text-only deletion never erases delivery receipts or reopens ASR."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import Mock

from django.core.exceptions import ValidationError
from django.core.files.storage import default_storage
from django.db import close_old_connections
from django.utils import timezone

import pytest
from storages.backends.s3 import S3Storage

from core import models
from core.services import capture_audio
from core.services import capture_audio_cleanup as service
from core.tasks import capture_audio as tasks
from core.tests.services.test_capture_transcription import request_job, saved
from core.tests.services.test_meeting_captures import ROOT
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_ASR_ENABLED = True
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def ready():
    user, capture = saved()
    result = request_job(user, capture)
    assert result.status_code == 201, result.data
    job = capture.transcription_jobs.get()
    # Simulate the published-ASR state; text uploads remain gated until the next batch.
    job.status = "succeeded"
    job.save(update_fields=["status"])
    capture.active_transcription = job
    capture.save(update_fields=["active_transcription"])
    models.MeetingRecord.objects.filter(pk=capture.record_id).update(
        retention_mode="text"
    )
    return user, capture, job


def test_deletion_is_idempotent_and_preserves_manifest_receipts_and_asr():
    _user, capture, asr = ready()
    chunk = capture.audio_chunks.get()
    assert default_storage.exists(chunk.object_key)
    manifest = capture.audio_manifest
    cleanup = service.schedule(capture.pk)
    assert service.schedule(capture.pk).pk == cleanup.pk
    assert service.step(cleanup.pk).state == "complete"
    chunk.refresh_from_db()
    assert chunk.audio_deleted_at and chunk.stored
    assert not default_storage.exists(chunk.object_key)
    assert models.CaptureAudioManifest.objects.filter(pk=manifest.pk).exists()
    assert models.CaptureTranscriptionJob.objects.get(pk=asr.pk).status == "succeeded"
    assert service.step(cleanup.pk).attempts == 1
    with pytest.raises(OSError):
        capture_audio.read_verified(chunk)
    chunk.audio_deleted_at = None
    with pytest.raises(ValidationError):
        chunk.clean()


def test_storage_failure_stays_pending_until_verified_retry(monkeypatch):
    _user, capture, _asr = ready()
    chunk = capture.audio_chunks.get()
    cleanup = service.schedule(capture.pk)
    storage = Mock()
    storage.delete.side_effect = OSError("private bucket detail must not escape")
    monkeypatch.setattr(service, "audio_storage", lambda: storage)
    result = service.step(cleanup.pk)
    assert result.state == "failed" and result.error_code == "storage_unavailable"
    assert result.completed_at is None and result.next_attempt_at > timezone.now()
    assert service.step(cleanup.pk).attempts == 1
    assert storage.delete.call_count == 1
    chunk.refresh_from_db()
    assert chunk.audio_deleted_at is None
    monkeypatch.setattr(service, "audio_storage", lambda: default_storage)
    models.CaptureAudioCleanup.objects.filter(pk=cleanup.pk).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1)
    )
    assert service.step(cleanup.pk).state == "complete"


def test_unconfirmed_delete_does_not_claim_completion(monkeypatch):
    _user, capture, _asr = ready()
    cleanup = service.schedule(capture.pk)
    storage = Mock()
    storage.exists.return_value = True
    monkeypatch.setattr(service, "audio_storage", lambda: storage)
    result = service.step(cleanup.pk)
    assert (
        result.error_code == "storage_delete_unconfirmed" and result.state == "failed"
    )
    assert capture.audio_chunks.get().audio_deleted_at is None


@pytest.mark.parametrize("versioning", ["Enabled", "Suspended"])
def test_versioned_storage_cannot_report_delete_marker_as_erasure(
    monkeypatch, versioning
):
    _user, capture, _asr = ready()
    cleanup = service.schedule(capture.pk)
    storage = Mock(spec=S3Storage)
    storage.bucket_name = "fixture-only"
    storage.connection.meta.client.get_bucket_versioning.return_value = {
        "Status": versioning
    }
    monkeypatch.setattr(service, "audio_storage", lambda: storage)
    result = service.step(cleanup.pk)
    assert (
        result.state == "failed"
        and result.error_code == "versioned_storage_requires_purge"
    )
    storage.delete.assert_not_called()
    assert capture.audio_chunks.get().audio_deleted_at is None


def test_versioning_is_rechecked_after_s3_delete():
    storage = Mock(spec=S3Storage)
    storage.bucket_name = "fixture-only"
    storage.exists.return_value = False
    storage.connection.meta.client.get_bucket_versioning.side_effect = [
        {},
        {"Status": "Enabled"},
    ]
    assert (
        service._delete_verified(storage, "fixture.wav")
        == "versioned_storage_requires_purge"
    )
    storage.connection.meta.client.get_bucket_versioning.side_effect = [{}, {}]
    assert service._delete_verified(storage, "fixture.wav") == ""


def test_missing_object_after_lost_delete_response_is_safe_to_confirm():
    _user, capture, _asr = ready()
    cleanup = service.schedule(capture.pk)
    chunk = capture.audio_chunks.get()
    default_storage.delete(chunk.object_key)
    assert service.step(cleanup.pk).state == "complete"


def test_never_deletes_a_noncanonical_path(monkeypatch):
    _user, capture, _asr = ready()
    cleanup = service.schedule(capture.pk)
    capture.audio_chunks.update(object_key="another-resource/private.wav")
    storage = Mock()
    monkeypatch.setattr(service, "audio_storage", lambda: storage)
    result = service.step(cleanup.pk)
    assert result.error_code == "invalid_chunk_identity"
    storage.delete.assert_not_called()


def test_media_records_and_unpublished_asr_are_ineligible():
    _user, capture, asr = ready()
    models.MeetingRecord.objects.filter(pk=capture.record_id).update(
        retention_mode="media"
    )
    assert service.schedule(capture.pk) is None
    models.MeetingRecord.objects.filter(pk=capture.record_id).update(
        retention_mode="text"
    )
    capture.active_transcription = None
    capture.save(update_fields=["active_transcription"])
    assert service.schedule(capture.pk) is None
    capture.active_transcription = asr
    capture.save(update_fields=["active_transcription"])
    models.CaptureTranscriptionJob.objects.filter(pk=asr.pk).update(status="running")
    assert service.schedule(capture.pk) is None


def test_cleanup_rechecks_retention_before_each_external_delete():
    _user, capture, _asr = ready()
    cleanup = service.schedule(capture.pk)
    models.MeetingRecord.objects.filter(pk=capture.record_id).update(
        retention_mode="media"
    )
    assert service.step(cleanup.pk).error_code == "capture_not_eligible"
    assert default_storage.exists(capture.audio_chunks.get().object_key)


def test_text_only_has_no_public_audio_download_even_before_cleanup():
    user, capture, _asr = ready()
    chunk = capture.audio_chunks.get()
    response = client_for(user).get(f"{ROOT}{capture.pk}/audio/{chunk.pk}/")
    assert response.status_code == 404
    assert default_storage.exists(chunk.object_key)


def test_cleanup_enrollment_fences_new_asr_and_stale_internal_reads():
    user, capture, asr = ready()
    stale = capture.audio_chunks.get()
    service.schedule(capture.pk)
    assert request_job(user, capture, expected=asr.pk).status_code == 409
    with pytest.raises(OSError):
        capture_audio.read_verified(stale)
    assert capture.transcription_jobs.count() == 1


def test_tick_recovers_missed_enrollment_when_rollout_disabled(settings):
    _user, capture, _asr = ready()
    settings.MEETING_CAPTURE_AUDIO_ENABLED = False
    settings.MEETING_CAPTURE_ASR_ENABLED = False
    settings.MEETING_RECORDS_ENABLED = False
    assert service.tick_audio_cleanup() == 1
    assert models.CaptureAudioCleanup.objects.get(capture=capture).state == "complete"
    assert service.tick_audio_cleanup() == 0


@pytest.mark.django_db(transaction=True)
def test_duplicate_workers_serialize_deletion_and_keep_one_completion():
    _user, capture, _asr = ready()
    cleanup = service.schedule(capture.pk)

    def run():
        close_old_connections()
        try:
            return service.step(cleanup.pk).state
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(lambda _: run(), range(2))) == ["complete", "complete"]
    cleanup.refresh_from_db()
    assert cleanup.attempts == 1


def test_tick_work_is_bounded_and_remaining_receipts_are_resumed():
    _user, capture, _asr = ready()
    exemplar = capture.audio_chunks.get()
    for sequence in range(2, 102):
        chunk_id = uuid.uuid4()
        models.CaptureAudioChunk.objects.create(
            id=chunk_id,
            capture=capture,
            sequence=sequence,
            start_ms=sequence * 1000,
            duration_ms=1000,
            checksum=exemplar.checksum,
            byte_size=exemplar.byte_size,
            object_key=f"capture-audio/{capture.record_id}/{capture.pk}/{chunk_id}.wav",
        )
    assert service.tick_audio_cleanup() == 100
    assert capture.audio_chunks.filter(audio_deleted_at__isnull=True).count() == 1
    assert models.CaptureAudioCleanup.objects.get(capture=capture).state == "pending"
    assert service.tick_audio_cleanup() == 1
    assert models.CaptureAudioCleanup.objects.get(capture=capture).state == "complete"


def test_cleanup_task_is_scheduled_separately_from_ai_work(settings, monkeypatch):
    tick = Mock(return_value=3)
    monkeypatch.setattr(tasks, "tick_audio_cleanup", tick)
    assert tasks.cleanup_capture_audio() == 3
    assert (
        settings.CELERY_BEAT_SCHEDULE["cleanup-capture-audio"]["task"]
        == "core.tasks.capture_audio.cleanup_capture_audio"
    )
