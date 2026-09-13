"""Text-only audio requires explicit rollout and compatible private storage."""

import uuid
from unittest.mock import Mock

from django.core.files.storage import default_storage

import pytest
from rest_framework.test import APIClient
from storages.backends.s3 import S3Storage

from core import models
from core.factories import UserFactory
from core.services import capture_audio, capture_audio_cleanup, capture_storage
from core.tests.services.test_capture_audio import recording, seal, upload
from core.tests.services.test_capture_transcription import (
    claim,
    control,
    final,
    finish,
    request_job,
)
from core.tests.services.test_meeting_captures import ROOT, command
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
CAPABILITIES = "/api/v1.0/capture-audio-capabilities/"


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_LIVE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_TEXT_ONLY_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.AGENT_INTERNAL_API_TOKEN = "asr-test-only"
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def test_text_capture_to_published_originals_and_verified_deletion():
    user, body, capture = recording("text")
    assert upload(user, body, capture).status_code == 200
    chunk = capture.audio_chunks.get()
    assert (
        client_for(user).get(f"{ROOT}{capture.pk}/audio/{chunk.pk}/").status_code == 404
    )
    assert command(user, body, capture, "stop").status_code == 200
    assert seal(user, body, capture).status_code == 200
    assert command(user, body, capture, "finalize").status_code == 200
    assert request_job(user, capture).status_code == 201
    worker, job = claim()
    assert control(job["id"], worker, "begin").status_code == 200
    assert (
        control(
            job["id"], worker, "ack_input", index=1, checksum=chunk.checksum
        ).status_code
        == 200
    )
    response, _ = final(job["id"], worker)
    assert response.status_code == 201
    result = finish(job["id"], worker)
    assert result.status_code == 200, result.data
    capture.refresh_from_db()
    assert capture.active_transcription.status == "succeeded"
    assert capture.original_segments.count() == 1
    assert capture_audio_cleanup.tick_audio_cleanup() == 1
    assert not default_storage.exists(chunk.object_key)
    assert capture.original_segments.count() == 1


def test_live_text_asr_starts_without_sealed_audio():
    user, body, capture = recording("text")
    assert upload(user, body, capture).status_code == 200
    result = client_for(user).post(
        f"{ROOT}{capture.pk}/transcription/",
        {"expected_job_id": None, "allow_incomplete": False, "live": True},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert result.status_code == 201, result.data
    assert capture.transcription_jobs.get().configuration["mode"] == "live"
    assert capture_audio_cleanup.tick_audio_cleanup() == 0


@pytest.mark.parametrize(
    "flag",
    [
        "MEETING_CAPTURE_TEXT_ONLY_ENABLED",
        "MEETING_CAPTURE_AUDIO_ENABLED",
        "MEETING_CAPTURE_ASR_ENABLED",
        "MEETING_CAPTURE_PROTOCOL_ENABLED",
        "MEETING_RECORDS_ENABLED",
        "CELERY_ENABLED",
    ],
)
def test_any_required_rollout_switch_closes_text_upload(settings, flag):
    user, body, capture = recording("text")
    setattr(settings, flag, False)
    response = client_for(user).get(CAPABILITIES)
    assert response.data == {
        "text_audio_available": False,
        "text_audio_error": "rollout_disabled",
    }
    assert upload(user, body, capture).status_code == 403


@pytest.mark.parametrize("versioning", ["Enabled", "Suspended"])
def test_versioned_bucket_fails_preflight_and_creating_text_audio(
    monkeypatch, versioning
):
    storage = Mock(spec=S3Storage)
    storage.bucket_name = "test-only"
    storage.connection.meta.client.get_bucket_versioning.return_value = {
        "Status": versioning
    }
    monkeypatch.setattr(capture_storage, "audio_storage", lambda: storage)
    user = UserFactory()
    response = client_for(user).get(CAPABILITIES)
    assert response.data == {
        "text_audio_available": False,
        "text_audio_error": "versioned_storage_requires_purge",
    }
    result = client_for(user).post(
        ROOT,
        {
            "device_id": "fixture",
            "lease_key": str(uuid.uuid4()),
            "retention_mode": "text",
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert result.status_code == 403
    assert not models.CaptureSession.objects.exists()
    storage.save.assert_not_called()


def test_bucket_change_after_preflight_blocks_each_new_upload(monkeypatch):
    user, body, capture = recording("text")
    assert client_for(user).get(CAPABILITIES).data["text_audio_available"] is True
    storage = Mock(spec=S3Storage)
    storage.bucket_name = "test-only"
    storage.connection.meta.client.get_bucket_versioning.return_value = {
        "Status": "Enabled"
    }
    monkeypatch.setattr(capture_audio, "audio_storage", lambda: storage)
    assert upload(user, body, capture).status_code == 403
    storage.save.assert_not_called()
    assert not capture.audio_chunks.get().stored


def test_preflight_is_authenticated_uncached_and_redacts_storage_errors(monkeypatch):
    assert APIClient().get(CAPABILITIES).status_code in {401, 403}
    monkeypatch.setattr(
        capture_storage, "audio_storage", Mock(side_effect=OSError("secret endpoint"))
    )
    response = client_for(UserFactory()).get(CAPABILITIES)
    assert response["Cache-Control"] == "private, no-store"
    assert response.data == {
        "text_audio_available": False,
        "text_audio_error": "storage_unavailable",
    }
    assert b"secret" not in response.content


def test_unknown_storage_is_not_assumed_to_support_erasure():
    assert capture_storage.text_storage_error(Mock()) == "unsupported_storage"


def test_rollout_rollback_allows_sealing_and_finishing_existing_text_audio(settings):
    user, body, capture = recording("text")
    assert upload(user, body, capture).status_code == 200
    settings.MEETING_CAPTURE_TEXT_ONLY_ENABLED = False
    assert command(user, body, capture, "stop").status_code == 200
    assert seal(user, body, capture).status_code == 200
    assert command(user, body, capture, "finalize").status_code == 200
    assert request_job(user, capture).status_code == 403
