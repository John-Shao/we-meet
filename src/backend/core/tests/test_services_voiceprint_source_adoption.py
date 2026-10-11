"""Upload idempotency survives private server receipts, without exposing them."""

import hashlib
from unittest import mock
from uuid import uuid4

from django.core.files.uploadedfile import SimpleUploadedFile

import pytest

from core.factories import UserFactory
from core.services import recording_upload_sessions as sessions
from core.services import uploaded_recordings as service
from core.services.voiceprint_source_objects import parse
from core.tests.services.test_direct_uploads import FakeStorage
from core.tests.services.test_recording_upload_multipart import (
    FakeStorage as MultipartStorage,
)
from core.tests.services.test_recording_upload_multipart import (
    complete_body,
    fill,
)
from core.tests.services.test_uploaded_recordings import enabled, wav_bytes

pytestmark = pytest.mark.django_db
OPTIONS = {"diarization": True, "hotwords": [], "context": ""}


def test_streamed_upload_records_the_real_content_hash_and_replays():
    actor, key = UserFactory(), uuid4()

    def upload():
        return service.create(
            actor,
            key,
            SimpleUploadedFile("meeting.wav", wav_bytes(), "audio/wav"),
            OPTIONS,
        )

    job = upload()
    receipt = parse(job.configuration["_identity_source"])
    assert (
        receipt.kind == "content_sha256"
        and receipt.sha256 == hashlib.sha256(wav_bytes()).hexdigest()
    )
    assert receipt.size == len(wav_bytes()) and receipt.key == job.storage_name
    assert upload().pk == job.pk
    assert "_identity_source" not in service.serialize(job)
    assert receipt.key not in repr(service.public_metadata(job))


@pytest.mark.parametrize("version", ["version-1", None, "null"])
def test_direct_completion_freezes_server_object_token_not_intent_hash(version):
    actor, key = UserFactory(), uuid4()
    storage = FakeStorage(stored_size=1024)
    storage.connection.meta.client.head_object.side_effect = lambda **kwargs: {
        "ContentLength": 1024,
        "ETag": '"server-token"',
        "VersionId": version,
    }
    with mock.patch.object(service, "audio_storage", return_value=storage):

        def complete():
            return service.complete_direct_upload(
                actor,
                key=key,
                name="meeting.wav",
                storage_name="record-uploads/synthetic.wav",
                size=1024,
                content_type="audio/wav",
                options=OPTIONS,
            )

        job = complete()
        proof = parse(job.configuration["_identity_source"])
        assert proof.kind == "s3_object" and proof.sha256 == ""
        assert proof.etag == '"server-token"' and proof.version_id == (
            None if version == "null" else version
        )
        assert (
            job.checksum
            == hashlib.sha256(b"record-uploads/synthetic.wav:1024").hexdigest()
        )
        assert complete().pk == job.pk
        assert "_identity_source" not in service.serialize(job)
        params = service.source_read_params(job, storage)
        assert params == {
            "Bucket": storage.bucket_name,
            "Key": job.storage_name,
            **({"VersionId": version} if version not in {None, "null"} else {}),
        }
        service.media_read_url(job)
        assert storage.signed[-1]["params"].get("VersionId") == proof.version_id


def test_missing_object_token_never_creates_a_false_digest_but_ordinary_upload_remains_available():
    actor = UserFactory()
    with mock.patch.object(
        service, "audio_storage", return_value=FakeStorage(stored_size=1024)
    ):
        job = service.complete_direct_upload(
            actor,
            key=uuid4(),
            name="meeting.wav",
            storage_name="record-uploads/synthetic.wav",
            size=1024,
            content_type="audio/wav",
            options=OPTIONS,
        )
    assert "_identity_source" not in job.configuration
    assert job.status == "queued"


def test_multipart_adoption_freezes_server_version_and_replays_without_head(settings):
    settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES = 6 * 1024**3
    actor, storage = UserFactory(), MultipartStorage()
    storage.connection.meta.client.head_object.side_effect = lambda **kwargs: {
        **storage._head(**kwargs),
        "ETag": '"server-multipart-token"',
        "VersionId": "server-multipart-version",
    }
    with (
        mock.patch.object(sessions, "direct_upload_available", return_value=True),
        mock.patch.object(sessions, "audio_storage", return_value=storage),
    ):
        session, _ = sessions.begin(
            actor,
            name="meeting.wav",
            size=2 * sessions.PART_SIZE,
            content_type="audio/wav",
            key=uuid4(),
            options=OPTIONS,
        )
        fill(storage)
        parts = complete_body(storage)["parts"]
        job = sessions.complete(actor, session.pk, parts)
        proof = parse(job.configuration["_identity_source"])
        assert proof.kind == "s3_object" and proof.sha256 == ""
        assert proof.etag == '"server-multipart-token"'
        assert proof.version_id == "server-multipart-version"
        assert proof.key == session.storage_name and proof.size == session.size
        assert job.checksum == sessions._session_checksum(session)
        heads = storage.connection.meta.client.head_object.call_count
        assert sessions.complete(actor, session.pk, parts).pk == job.pk
        assert storage.connection.meta.client.head_object.call_count == heads
        assert "_identity_source" not in service.serialize(job)
        assert service.source_read_params(job, storage)["VersionId"] == proof.version_id
