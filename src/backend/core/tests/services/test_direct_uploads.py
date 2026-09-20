"""Direct (presigned) uploads keep bytes off the app and never trust client claims.

The multipart path spools the whole file through the application, so its ceiling
is bounded by app disk. This path signs a PUT whose ContentLength is part of the
signature and then adopts the resulting object — which is what makes a GB-scale
import possible. These tests pin the guarantees that make that safe:

* the declared size is the storage-enforced ceiling, not a hint;
* completion re-verifies the object instead of believing the client;
* adoption cannot be pointed outside this service's own key prefix;
* a repeated intent never creates a second paid job.
"""

import uuid

from unittest import mock

import pytest

from core import models
from core.factories import UserFactory
from core.services import uploaded_recordings as service


pytestmark = pytest.mark.django_db

PRESIGN = "/api/v1.0/recording-uploads/upload-url/"
COMPLETE = "/api/v1.0/recording-uploads/upload-complete/"
WAV_MIME = "audio/wav"


def client_for(user):
    from rest_framework.test import APIClient

    client = APIClient()
    client.force_authenticate(user=user)
    return client


class FakeStorage:
    """Minimal S3Storage stand-in: only what the direct path actually touches."""

    bucket_name = "private-bucket"
    location = ""
    # A real WAV header so magic-based verification sees audio/x-wav.
    leading = b"RIFF$\x00\x00\x00WAVEfmt " + b"\x00" * 40

    def __init__(self, *, stored_size=None, head_error=None):
        self.stored_size = stored_size
        self.head_error = head_error
        self.deleted = []
        self.signed = []
        self.connection = mock.Mock()
        self.connection.meta.client.head_object.side_effect = (
            self.head_error if self.head_error else self._head
        )
        self.connection.meta.client.get_object.side_effect = self._get
        self.connection.meta.client.generate_presigned_url.side_effect = self._presign

    def _head(self, **kwargs):
        return {"ContentLength": self.stored_size}

    def _get(self, **kwargs):
        return {"Body": mock.Mock(read=lambda _n: self.leading)}

    def _presign(self, ClientMethod=None, Params=None, ExpiresIn=None):
        self.signed.append({"method": ClientMethod, "params": Params, "expires": ExpiresIn})
        return "https://private-bucket.oss.example/put?sig=test"

    def _normalize_name(self, name):
        # Mirrors the traversal-collapsing behavior the real backend provides.
        parts = [p for p in name.split("/") if p not in ("", ".", "..")]
        if name.startswith("/") or ".." in name.split("/"):
            raise ValueError("Invalid storage name")
        return "/".join(parts)

    def delete(self, name):
        self.deleted.append(name)


@pytest.fixture(autouse=True)
def direct_enabled(settings):
    settings.MEETING_FILE_DIRECT_UPLOAD_ENABLED = True
    settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES = 6 * 1024 * 1024 * 1024
    settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS = 3600
    with mock.patch.object(service, "available", return_value=True):
        yield


def with_storage(storage):
    return mock.patch.object(service, "audio_storage", return_value=storage)


def presign(user, storage=None, **overrides):
    storage = storage or FakeStorage(stored_size=1024)
    body = {
        "key": str(uuid.uuid4()),
        "name": "meeting.wav",
        "size": 1024,
        "content_type": WAV_MIME,
        **overrides,
    }
    with with_storage(storage):
        response = client_for(user).post(PRESIGN, body, format="json")
    return response, storage, body


def test_presign_binds_the_declared_size_into_the_signature():
    """A client that declares 1 KiB and sends more must fail at storage, not here."""
    response, storage, _ = presign(UserFactory(), stored_size=1024)
    assert response.status_code == 200, response.data
    signed = storage.signed[0]
    assert signed["method"] == "put_object"
    assert signed["params"]["ContentLength"] == 1024
    assert signed["params"]["ACL"] == "private"
    assert signed["params"]["Bucket"] == "private-bucket"
    assert signed["expires"] == 3600
    # The client echoes this exact key back; it is a storage key, not a URL.
    assert response.data["storage_name"].startswith("record-uploads/")
    assert "upload_url" in response.data
    assert response.data["max_bytes"] == 6 * 1024 * 1024 * 1024


@pytest.mark.django_db(transaction=True)
def test_presign_works_without_a_request_transaction():
    """Production requests run in autocommit; TestCase must not hide row-lock errors."""
    response, storage, _ = presign(UserFactory())
    assert response.status_code == 200, response.data
    assert len(storage.signed) == 1
    assert models.UploadedRecording.objects.count() == 0


def test_presign_rejects_an_extension_the_mime_does_not_allow():
    owner = UserFactory()
    response, _, _ = presign(owner, name="clip.wav", content_type="video/mp4")
    assert response.status_code == 400


def test_presign_rejects_an_unknown_extension():
    response, _, _ = presign(UserFactory(), name="clip.txt", content_type="text/plain")
    assert response.status_code == 400


def test_presign_rejects_a_size_over_the_direct_ceiling(settings):
    settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES = 2048
    response, storage, _ = presign(UserFactory(), size=4096, stored_size=4096)
    assert response.status_code == 400
    assert storage.signed == []  # nothing was signed for a rejected declaration


def test_presign_is_unavailable_when_the_feature_is_off(settings):
    settings.MEETING_FILE_DIRECT_UPLOAD_ENABLED = False
    response, storage, _ = presign(UserFactory(), stored_size=1024)
    assert response.status_code == 503
    assert storage.signed == []


DECLARED_SIZE = 1024


def complete(user, storage, **overrides):
    """Declare 1 KiB; the fake object's own length is what varies per test."""
    body = {
        "key": str(uuid.uuid4()),
        "name": "meeting.wav",
        "size": DECLARED_SIZE,
        "content_type": WAV_MIME,
        "storage_name": "record-uploads/abc.wav",
        **overrides,
    }
    with with_storage(storage):
        response = client_for(user).post(COMPLETE, body, format="json")
    return response, body


def test_complete_adopts_the_verified_object_and_creates_one_job():
    owner = UserFactory()
    storage = FakeStorage(stored_size=DECLARED_SIZE)
    response, body = complete(owner, storage)
    assert response.status_code == 202, response.data
    assert response.data["status"] == "queued"
    assert models.UploadedRecording.objects.count() == 1
    job = models.UploadedRecording.objects.get()
    assert job.record.owner_id == owner.pk
    assert job.record.source_type == "upload"
    assert job.storage_name == body["storage_name"]
    assert job.size == DECLARED_SIZE
    assert job.configuration["_file"]["media_type"] == "audio"
    # Public projection must not leak the storage key.
    assert "storage_name" not in response.data


def test_complete_rejects_a_stored_object_whose_length_disagrees():
    """The declaration is checked against the object, never trusted."""
    storage = FakeStorage(stored_size=DECLARED_SIZE + 1)
    response, _ = complete(UserFactory(), storage)
    assert response.status_code == 400
    assert models.UploadedRecording.objects.count() == 0
    assert storage.deleted == []  # nothing was adopted, so nothing is cleaned up


def test_complete_rejects_a_key_outside_the_upload_prefix():
    """Adoption cannot be pointed at an arbitrary object in the bucket."""
    storage = FakeStorage(stored_size=DECLARED_SIZE)
    response, _ = complete(
        UserFactory(), storage, storage_name="avatars/someone-else.png"
    )
    assert response.status_code == 400
    assert models.UploadedRecording.objects.count() == 0


def test_complete_rejects_a_traversal_key():
    storage = FakeStorage(stored_size=DECLARED_SIZE)
    response, _ = complete(
        UserFactory(), storage, storage_name="record-uploads/../../avatars/x.png"
    )
    assert response.status_code == 400
    assert models.UploadedRecording.objects.count() == 0


def test_complete_rejects_content_that_does_not_match_the_extension():
    """A wrong extension is caught before any provider is billed."""
    storage = FakeStorage(stored_size=DECLARED_SIZE)
    storage.leading = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40  # a PNG, not audio
    response, _ = complete(UserFactory(), storage)
    assert response.status_code == 400
    assert models.UploadedRecording.objects.count() == 0


def test_complete_replays_the_same_intent_without_a_second_paid_job():
    owner = UserFactory()
    storage = FakeStorage(stored_size=DECLARED_SIZE)
    first, body = complete(owner, storage)
    assert first.status_code == 202, first.data
    with with_storage(storage):
        second = client_for(owner).post(COMPLETE, body, format="json")
    assert second.status_code == 202
    assert second.data == first.data
    assert models.UploadedRecording.objects.count() == 1


def test_complete_rejects_a_changed_intent_for_the_same_key():
    owner = UserFactory()
    storage = FakeStorage(stored_size=DECLARED_SIZE)
    first, body = complete(owner, storage)
    assert first.status_code == 202, first.data
    with with_storage(storage):
        changed = client_for(owner).post(
            COMPLETE, {**body, "context": "different"}, format="json"
        )
    assert changed.status_code == 409
    assert models.UploadedRecording.objects.count() == 1
