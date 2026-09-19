"""Sign one whole-object GET for an uploaded file, so it can be replayed.

An uploaded file is sealed: it lands complete and never changes. Live captures
are the opposite — their audio arrives incrementally and can have gaps — which is
why playback for them is a chunk table behind a manifest. Imitating that for a
sealed file would mean a transcode job, a chunk table and a manifest that exist
only to re-serve something the storage service already holds.

A signed GET supports HTTP Range natively, so an audio element or ExoPlayer seeks
exactly where a transcript citation points without any of that machinery.

The bytes never pass through the application: only the signed URL does.
"""

from unittest import mock

import pytest

from core import models
from core.factories import UserFactory
from core.services import uploaded_recordings as service
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_uploaded_recordings import enabled, job_for

pytestmark = pytest.mark.django_db

MEDIA = "/api/v1.0/meeting-records/{}/media/"


class FakeStorage:
    """Only what signing touches: a bucket, a location, and one signer."""

    bucket_name = "private-bucket"
    location = ""

    def __init__(self):
        self.connection = mock.Mock()
        self.signed = []
        self.connection.meta.client.generate_presigned_url.side_effect = self._sign

    def _sign(self, ClientMethod=None, Params=None, ExpiresIn=None, **_):
        self.signed.append(
            {"method": ClientMethod, "params": Params, "expires": ExpiresIn}
        )
        return "https://private-bucket.oss.example/recording?sig=test"


def upload_job(user=None, **overrides):
    """A succeeded upload whose record still retains its media."""
    job = job_for(user or UserFactory())
    for field, value in overrides.items():
        setattr(job, field, value)
    job.save()
    return job


def get(user, job, storage=None):
    storage = storage or FakeStorage()
    with mock.patch.object(service, "audio_storage", return_value=storage):
        response = client_for(user).get(MEDIA.format(job.record_id))
    return response, storage


def test_signed_get_names_the_object_size_and_type_without_its_key():
    job = upload_job()
    response, storage = get(job.record.owner, job)
    assert response.status_code == 200, response.data
    signed = storage.signed[0]
    assert signed["method"] == "get_object"
    assert signed["params"]["Bucket"] == "private-bucket"
    assert signed["params"]["Key"].endswith(job.storage_name)
    assert signed["expires"] == service.MEDIA_GET_URL_TTL_SECONDS
    assert response.data["url"].startswith("https://")
    assert response.data["size"] == job.size
    assert response.data["media_type"] in {"audio", "video"}
    # The bare object key stays server-side; only the signed URL crosses the wire.
    assert "storage_name" not in response.data
    assert "ResponseContentDisposition" not in signed["params"]


def test_download_signs_attachment_with_safe_unicode_filename():
    job = upload_job()
    job.configuration = {
        **job.configuration,
        "_file": {"name": "C:\\private\\会议\r\n.wav"},
    }
    job.save(update_fields=["configuration"])
    storage = FakeStorage()
    with mock.patch.object(service, "audio_storage", return_value=storage):
        response = client_for(job.record.owner).get(
            MEDIA.format(job.record_id), {"download": "true"}
        )
    assert response.status_code == 200
    assert response.data["name"] == "会议.wav"
    disposition = storage.signed[0]["params"]["ResponseContentDisposition"]
    assert disposition.startswith("attachment;")
    assert "filename*=utf-8''" in disposition
    assert "\r" not in disposition and "\n" not in disposition
    assert "private" not in disposition


def test_transcript_grant_does_not_allow_original_file_download():
    job = upload_job()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=job.record, user=reader, read_transcript=True
    )
    storage = FakeStorage()
    with mock.patch.object(service, "audio_storage", return_value=storage):
        response = client_for(reader).get(
            MEDIA.format(job.record_id), {"download": "true"}
        )
    assert response.status_code == 404 and storage.signed == []


def test_a_reader_who_may_not_read_the_record_gets_nothing_signed():
    job = upload_job()
    response, storage = get(UserFactory(), job)
    assert response.status_code == 404
    assert storage.signed == []


def test_media_is_refused_once_the_record_no_longer_retains_it():
    """Retention is the switch: text-only means there is nothing left to sign."""
    job = upload_job()
    job.record.retention_mode = models.MeetingRecord.Retention.TEXT
    job.record.save(update_fields=["retention_mode"])
    response, storage = get(job.record.owner, job)
    assert response.status_code == 404
    assert storage.signed == []


def test_this_path_does_not_serve_capture_or_meeting_records():
    """It exists for sealed uploads; other sources have their own playback."""
    owner = UserFactory()
    record = models.MeetingRecord.objects.create(
        owner=owner,
        source_type="audio_recording",
        title="Captured",
        origin_at=job_for(owner).record.origin_at,
        retention_mode="media",
    )
    response, storage = get(owner, type("J", (), {"record_id": record.id})())
    assert response.status_code == 404
    assert storage.signed == []


def test_upload_capabilities_match_owner_playback_and_guarded_rename():
    job = upload_job()
    path = f"/api/v1.0/meeting-records/{job.record_id}/"
    owner = client_for(job.record.owner)
    caps = owner.get(path).data["capabilities"]
    assert caps["play_media"] is True
    assert caps["download_media"] is True
    assert caps["rename"] is True
    renamed = owner.patch(
        path + "title/",
        {"title": "Interview", "expected_title": job.record.title},
        format="json",
    )
    assert renamed.status_code == 200
    assert renamed.data["title"] == "Interview"
    assert renamed.data["revision"] == job.record.revision
    assert (
        owner.patch(
            path + "title/",
            {"title": "Stale", "expected_title": job.record.title},
            format="json",
        ).status_code
        == 409
    )
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=job.record, user=reader, read_transcript=True
    )
    caps = client_for(reader).get(path).data["capabilities"]
    assert caps["read_transcript"] is True
    assert caps["play_media"] is False
    assert caps["download_media"] is False
    assert caps["rename"] is False
    assert get(reader, job)[0].status_code == 404
    models.UploadedRecording.objects.filter(pk=job.pk).update(storage_name="")
    assert owner.get(path).data["capabilities"]["play_media"] is False
    assert owner.get(path).data["capabilities"]["download_media"] is False
