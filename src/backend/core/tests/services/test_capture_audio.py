"""Real WAV storage receipts, recovery, source boundaries and immutable sealing."""

import hashlib
import io
import uuid
import wave

from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile

import pytest

from core import models
from core.factories import UserFactory
from core.services import capture_audio as service
from core.tests.services.test_meeting_captures import ROOT, command, create
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def wav(*, rate=16000, channels=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(b"\x01\x00" * rate * channels)
    return output.getvalue()


def recording(retention="media"):
    user, body, capture, _ = create(
        body={
            "device_id": "web",
            "lease_key": str(uuid.uuid4()),
            "title": "Private recording",
            "retention_mode": retention,
        }
    )
    assert command(user, body, capture, "start").status_code == 200
    return user, body, capture


def upload(user, body, capture, *, data=None, sequence=1, start_ms=0, **overrides):  # noqa: PLR0913
    data = wav() if data is None else data
    return client_for(user).post(
        f"{ROOT}{capture.pk}/audio/upload/",
        {
            "device_id": body["device_id"],
            "sequence": sequence,
            "start_ms": start_ms,
            "checksum": hashlib.sha256(data).hexdigest(),
            "audio": SimpleUploadedFile("source.wav", data, content_type="audio/wav"),
            **overrides,
        },
        format="multipart",
        HTTP_X_CAPTURE_LEASE=body["lease_key"],
    )


def seal(user, body, capture, final=1):
    return client_for(user).post(
        f"{ROOT}{capture.pk}/audio/seal/",
        {"device_id": body["device_id"], "final_sequence": final},
        format="json",
        HTTP_X_CAPTURE_LEASE=body["lease_key"],
    )


def test_upload_replay_and_protected_download_verify_real_bytes():
    user, body, capture = recording()
    first = upload(user, body, capture)
    assert first.status_code == 200, first.data
    assert first.data["stored"] and first.data["duration_ms"] == 1000
    assert upload(user, body, capture).data == first.data
    assert models.CaptureAudioChunk.objects.count() == 1
    assert "object_key" not in first.data
    response = client_for(user).get(f"{ROOT}{capture.pk}/audio/{first.data['id']}/")
    assert response.content == wav()
    assert response["Cache-Control"] == "private, no-store"
    assert upload(user, body, capture, start_ms=1000).status_code == 409
    state = client_for(user).get(f"{ROOT}{capture.pk}/").data
    assert state["media_status"] == "uploading" and state["last_acked_sequence"] == 1


@pytest.mark.parametrize(
    "data", [b"not audio", wav(rate=44100), wav(channels=2), wav()[:-2]]
)
def test_rejects_mislabeled_invalid_audio(data):
    user, body, capture = recording()
    assert upload(user, body, capture, data=data).status_code == 400
    assert not models.CaptureAudioChunk.objects.exists()


def test_checksums_size_timeline_and_reorder_window():
    user, body, capture = recording()
    assert upload(user, body, capture, checksum="0" * 64).status_code == 400
    assert (
        upload(user, body, capture, data=b"a" * (service.MAX_BYTES + 1)).status_code
        == 413
    )
    assert upload(user, body, capture, sequence=21).status_code == 409
    assert upload(user, body, capture, sequence=2, start_ms=1000).status_code == 200
    assert upload(user, body, capture, sequence=1, start_ms=500).status_code == 409
    assert upload(user, body, capture).status_code == 200
    assert upload(user, body, capture, sequence=3, start_ms=500).status_code == 409


def test_recovers_saved_object_without_successful_database_receipt():
    user, body, capture = recording()
    data = wav()
    chunk = service.prepare(
        capture.pk,
        user,
        body["lease_key"],
        {
            "device_id": body["device_id"],
            "sequence": 1,
            "start_ms": 0,
            "checksum": hashlib.sha256(data).hexdigest(),
        },
        data,
    )
    assert not chunk.stored
    assert default_storage.save(chunk.object_key, ContentFile(data)) == chunk.object_key
    assert upload(user, body, capture).status_code == 200
    chunk.refresh_from_db()
    assert chunk.stored
    assert (
        len(list(default_storage.listdir(chunk.object_key.rsplit("/", 1)[0])[1])) == 1
    )


def test_sealing_reports_missing_chunks_and_prevents_late_rewrite():
    user, body, capture = recording()
    assert upload(user, body, capture, sequence=2, start_ms=2000).status_code == 200
    assert seal(user, body, capture, 2).status_code == 409
    assert command(user, body, capture, "stop").status_code == 200
    assert command(user, body, capture, "finalize").status_code == 409
    response = seal(user, body, capture, 2)
    assert response.status_code == 200, response.data
    assert response.data == {
        "final_sequence": 2,
        "client_interrupted": False,
        "outcome": "incomplete",
        "duration_ms": 1000,
        "missing_sequences": [1],
        "gaps": [{"start_ms": 0, "end_ms": 2000}],
        "coverage_status": "unverified",
    }
    assert seal(user, body, capture, 2).data == response.data
    assert seal(user, body, capture, 3).status_code == 409
    assert upload(user, body, capture).status_code == 409
    finished = command(user, body, capture, "finalize")
    assert finished.status_code == 200
    assert finished.data["capture"]["media_status"] == "incomplete"
    assert finished.data["capture"]["last_acked_sequence"] == 0
    manifest = models.CaptureAudioManifest.objects.get()
    with pytest.raises(ValidationError):
        manifest.save()


def test_corrupt_or_missing_acknowledged_object_never_rewrites_receipt():
    user, body, capture = recording()
    assert upload(user, body, capture).status_code == 200
    chunk = models.CaptureAudioChunk.objects.get()
    default_storage.delete(chunk.object_key)
    assert upload(user, body, capture).status_code == 409
    default_storage.save(chunk.object_key, ContentFile(b"broken"))
    assert (
        client_for(user).get(f"{ROOT}{capture.pk}/audio/{chunk.pk}/").status_code == 503
    )
    assert upload(user, body, capture).status_code == 503
    chunk.start_ms = 3000
    with pytest.raises(ValidationError):
        chunk.save()


def test_owner_lease_retention_and_current_account_are_required(settings):
    user, body, capture = recording()
    assert upload(UserFactory(), body, capture).status_code == 404
    assert (
        upload(user, {**body, "lease_key": str(uuid.uuid4())}, capture).status_code
        == 403
    )
    assert upload(user, body, capture, device_id="other").status_code == 403
    assert upload(user, body, capture).status_code == 200
    settings.MEETING_CAPTURE_AUDIO_ENABLED = False
    assert upload(user, body, capture).status_code == 403
    assert client_for(user).get(f"{ROOT}{capture.pk}/audio/").status_code == 200
    models.User.objects.filter(pk=user.pk).update(is_active=False)
    assert client_for(user).get(f"{ROOT}{capture.pk}/audio/").status_code in (403, 404)
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    user2, body2, capture2 = recording("text")
    assert upload(user2, body2, capture2).status_code == 403


def test_disabled_rollout_allows_existing_audio_to_finish_without_new_capture(settings):
    user, body, capture = recording()
    assert upload(user, body, capture).status_code == 200
    settings.MEETING_RECORDS_ENABLED = False
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = False
    settings.MEETING_CAPTURE_AUDIO_ENABLED = False
    assert client_for(user).get(f"{ROOT}{capture.pk}/").status_code == 200
    assert command(user, body, capture, "pause").status_code == 403
    assert upload(user, body, capture, sequence=2, start_ms=1000).status_code == 403
    assert command(user, body, capture, "stop").status_code == 200
    assert seal(user, body, capture, 2).data["outcome"] == "incomplete"
    assert command(user, body, capture, "finalize").status_code == 200


def test_interrupted_client_cannot_claim_complete_audio_despite_all_receipts():
    user, body, capture = recording()
    assert upload(user, body, capture).status_code == 200
    assert command(user, body, capture, "stop").status_code == 200
    response = client_for(user).post(
        f"{ROOT}{capture.pk}/audio/seal/",
        {
            "device_id": body["device_id"],
            "final_sequence": 1,
            "client_interrupted": True,
        },
        format="json",
        HTTP_X_CAPTURE_LEASE=body["lease_key"],
    )
    assert response.status_code == 200
    assert response.data["outcome"] == "incomplete"
    assert response.data["missing_sequences"] == []
    assert seal(user, body, capture).status_code == 409
