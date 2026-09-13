"""Expiry fences work before deletion, including abandoned and failed recordings."""

import uuid
from datetime import timedelta

from django.core.files.storage import default_storage
from django.utils import timezone

import pytest

from core import models
from core.services import capture_audio, capture_audio_cleanup, capture_retention
from core.services import capture_transcription as asr
from core.services.meeting_captures import capture_state
from core.tests.services.test_capture_audio import recording, seal, upload
from core.tests.services.test_capture_transcription import request_job, saved
from core.tests.services.test_meeting_captures import ROOT, command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_TEXT_ONLY_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def text(capture):
    models.MeetingRecord.objects.filter(pk=capture.record_id).update(
        retention_mode="text"
    )
    capture.refresh_from_db()
    return capture


@pytest.mark.parametrize("outcome", [None, "incomplete", "canceled"])
def test_unstarted_or_failed_asr_is_cleaned_at_retry_deadline(monkeypatch, outcome):
    user, capture = saved()
    if outcome:
        assert request_job(user, capture).status_code == 201
        capture.transcription_jobs.update(status=outcome)
    text(capture)
    hard, retry = capture_retention.deadlines(capture)
    assert retry < hard
    monkeypatch.setattr(timezone, "now", lambda: retry - timedelta(microseconds=1))
    assert capture_audio_cleanup.tick_audio_cleanup() == 0
    monkeypatch.setattr(timezone, "now", lambda: retry)
    assert request_job(user, capture).status_code == 409
    assert capture_audio_cleanup.tick_audio_cleanup() == 1
    assert capture.audio_chunks.get().audio_deleted_at == retry
    assert capture.audio_chunks.get().stored


def test_active_asr_may_finish_after_retry_window_but_never_after_hard_limit(
    monkeypatch,
):
    user, capture = saved()
    key = uuid.uuid4()
    response = request_job(user, capture, key=key)
    assert response.status_code == 201
    job = capture.transcription_jobs.get()
    text(capture)
    hard, retry = capture_retention.deadlines(capture)
    job.status = "running"
    job.deadline = job.lease_until = hard + timedelta(minutes=1)
    job.save(update_fields=["status", "deadline", "lease_until"])
    monkeypatch.setattr(timezone, "now", lambda: retry)
    assert capture_audio_cleanup.tick_audio_cleanup() == 0
    assert asr.state(capture.pk, user)["results"][0]["status"] == "running"
    assert capture_audio.read_verified(capture.audio_chunks.get())
    monkeypatch.setattr(timezone, "now", lambda: hard)
    state = asr.state(capture.pk, user)
    assert state["results"][0]["error_code"] == "temporary_audio_expired"
    assert state["audio_retention"]["expired"] is True
    assert capture_audio_cleanup.tick_audio_cleanup() == 0
    with pytest.raises(OSError):
        capture_audio.read_verified(capture.audio_chunks.get())
    # A late retry of the original intent resolves that same terminal generation.
    replay = request_job(user, capture, key=key)
    assert replay.status_code == 200 and replay.data["job"]["id"] == str(job.pk)
    assert capture.transcription_jobs.count() == 1
    monkeypatch.setattr(timezone, "now", lambda: hard + capture_retention.WORKER_DRAIN)
    assert capture_audio_cleanup.tick_audio_cleanup() == 1


@pytest.mark.parametrize("status", ["recording", "paused", "interrupted", "stopping"])
def test_abandoned_audio_is_deleted_and_can_still_be_closed(monkeypatch, status):
    user, body, capture = recording()
    assert upload(user, body, capture).status_code == 200
    models.CaptureSession.objects.filter(pk=capture.pk).update(status=status)
    text(capture)
    hard, _ = capture_retention.deadlines(capture)
    monkeypatch.setattr(timezone, "now", lambda: hard + capture_retention.WORKER_DRAIN)
    assert upload(user, body, capture).status_code == 409
    if status in {"paused", "interrupted"}:
        assert command(user, body, capture, "resume").status_code == 409
    assert capture_audio_cleanup.tick_audio_cleanup() == 1
    assert not default_storage.exists(capture.audio_chunks.get().object_key)
    if status != "stopping":
        assert command(user, body, capture, "stop").status_code == 200
    assert seal(user, body, capture).status_code == 200
    assert command(user, body, capture, "finalize").status_code == 200
    capture.refresh_from_db()
    assert capture.status == "stopped"
    # Closing an abandoned capture cannot extend the original hard deadline.
    assert capture_retention.deadlines(capture) == (hard, hard)


def test_hard_expiry_reconciles_active_jobs_without_asr_worker(monkeypatch, settings):
    user, capture = saved()
    assert request_job(user, capture).status_code == 201
    text(capture)
    hard, _ = capture_retention.deadlines(capture)
    monkeypatch.setattr(timezone, "now", lambda: hard + capture_retention.WORKER_DRAIN)
    settings.MEETING_CAPTURE_ASR_ENABLED = False
    settings.MEETING_RECORDS_ENABLED = False
    assert capture_audio_cleanup.tick_audio_cleanup() == 1
    job = capture.transcription_jobs.get()
    assert (job.status, job.error_code) == ("incomplete", "temporary_audio_expired")


def test_public_retention_does_not_claim_expired_audio_is_deleted(monkeypatch):
    user, capture = saved()
    text(capture)
    hard, retry = capture_retention.deadlines(capture)
    monkeypatch.setattr(timezone, "now", lambda: hard + capture_retention.WORKER_DRAIN)
    before = client_for(user).get(f"{ROOT}{capture.pk}/").data["audio_retention"]
    assert before == {
        "mode": "text",
        "temporary_until": hard.isoformat(),
        "retry_until": retry.isoformat(),
        "expired": True,
        "cleanup_status": "not_started",
        "cleanup_error": "",
        "deleted_at": None,
    }
    assert capture_audio_cleanup.tick_audio_cleanup() == 1
    after = capture_state(capture)["audio_retention"]
    assert after["cleanup_status"] == "complete" and after["deleted_at"]


def test_media_retention_has_no_text_audio_deadline(monkeypatch):
    _user, capture = saved()
    now = timezone.now() + timedelta(days=2)
    monkeypatch.setattr(timezone, "now", lambda: now)
    assert capture_retention.deadlines(capture) == (None, None)
    assert capture_audio_cleanup.tick_audio_cleanup() == 0
    assert capture_audio.read_verified(capture.audio_chunks.get())
