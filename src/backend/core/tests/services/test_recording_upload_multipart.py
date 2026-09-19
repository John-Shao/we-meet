"""Resumable chunked uploads: open, sign, resume, complete, abort.

The point of this path is that a broken transfer does not mean starting over, so
these tests are mostly about what happens *around* the bytes: who remembers the
storage upload id, what counts as "already uploaded", and what stops a client
from completing an upload that is quietly missing data.

`moto` is not a dependency of this project, so there is no full round trip
against a real multipart implementation here. The seam is the same one the
whole-file direct tests use (`audio_storage`), which means the orchestration and
every guard is covered, while the storage service's own behaviour is not. That
distinction is written down rather than glossed: see the plan doc.
"""

import io
import uuid
from unittest import mock

import pytest
from botocore.exceptions import ClientError

from core import models
from core.factories import UserFactory
from core.services import recording_upload_sessions as sessions
from core.services import uploaded_recordings as service
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_uploaded_recordings import wav_bytes

pytestmark = pytest.mark.django_db

BEGIN = "/api/v1.0/recording-uploads/multipart/begin/"
SESSION = "/api/v1.0/recording-uploads/multipart/{}/"
PARTS = "/api/v1.0/recording-uploads/multipart/{}/parts/"
WAV_MIME = "audio/wav"
#: Two parts exactly: big enough to be multi-part, small enough to stay fast.
SIZE = 2 * sessions.PART_SIZE


class FakeStorage:
    """A multipart-capable storage stand-in: only what this path touches."""

    bucket_name = "private-bucket"
    location = ""

    def __init__(self):
        self.deleted = []
        self.signed = []
        self.created = []
        self.completed = []
        self.aborted = []
        #: part_number -> (etag, size); tests write here to simulate arrivals.
        self.parts = {}
        self.connection = mock.Mock()
        client = self.connection.meta.client
        client.head_object.side_effect = self._head
        client.get_object.side_effect = lambda **_: {"Body": io.BytesIO(wav_bytes())}
        client.create_multipart_upload.side_effect = self._create
        client.list_parts.side_effect = self._list
        client.complete_multipart_upload.side_effect = self._complete
        client.abort_multipart_upload.side_effect = self._abort
        client.generate_presigned_url.side_effect = self._presign

    def _create(self, **kwargs):
        self.created.append(kwargs)
        return {"UploadId": f"upload-{len(self.created)}"}

    def _head(self, **kwargs):
        if not any(item["Key"] == kwargs["Key"] for item in self.completed):
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        declared = next(item for item in self.created if item["Key"] == kwargs["Key"])
        return {
            "ContentLength": sum(size for _, size in self.parts.values()),
            "ContentType": declared["ContentType"],
            "Metadata": declared["Metadata"],
        }

    def _list(self, **kwargs):
        if any(item["Key"] == kwargs["Key"] for item in self.completed):
            raise ClientError({"Error": {"Code": "NoSuchUpload"}}, "ListParts")
        return {
            "Parts": [
                {
                    "PartNumber": number,
                    "ETag": f'"{etag}"',
                    "Size": size,
                }
                for number, (etag, size) in sorted(self.parts.items())
            ],
            "IsTruncated": False,
        }

    def _complete(self, **kwargs):
        self.completed.append(kwargs)
        return {"Key": kwargs.get("Key")}

    def _abort(self, **kwargs):
        self.aborted.append(kwargs)
        return {}

    def _presign(self, ClientMethod=None, Params=None, ExpiresIn=None):
        self.signed.append(
            {"method": ClientMethod, "params": Params, "expires": ExpiresIn}
        )
        return f"https://bucket.example/{ClientMethod}/{Params.get('PartNumber')}?sig=x"

    def delete(self, name):
        self.deleted.append(name)


@pytest.fixture(autouse=True)
def multipart_enabled(settings):
    settings.MEETING_FILE_DIRECT_UPLOAD_ENABLED = True
    settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES = 6 * 1024 * 1024 * 1024
    settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS = 3600
    with mock.patch.object(service, "available", return_value=True):
        yield


@pytest.fixture
def storage():
    fake = FakeStorage()
    with mock.patch.object(sessions, "audio_storage", return_value=fake):
        yield fake


def begin(user, storage, **overrides):
    body = {
        "key": str(uuid.uuid4()),
        "name": "interview.wav",
        "size": SIZE,
        "content_type": WAV_MIME,
        **overrides,
    }
    return client_for(user).post(BEGIN, body, format="json"), body


def fill(storage, size=SIZE, part_size=sessions.PART_SIZE):
    """Mark every part as stored, the way a finished transfer would leave it."""
    total = -(-size // part_size)
    for number in range(1, total + 1):
        length = part_size if number < total else size - part_size * (total - 1)
        storage.parts[number] = (f"etag{number}", length)
    return total


def complete_body(storage):
    return {
        "parts": [
            {"part_number": number, "etag": etag}
            for number, (etag, _size) in sorted(storage.parts.items())
        ]
    }


# --- opening -----------------------------------------------------------------


def test_begin_declares_the_whole_plan_before_any_byte_moves(storage):
    owner = UserFactory()
    response, _ = begin(owner, storage)
    assert response.status_code == 200, response.data
    assert response.data["part_size"] == sessions.PART_SIZE
    assert response.data["part_count"] == 2
    assert response.data["size"] == SIZE
    assert response.data["uploaded"] == []
    assert response.data["uploaded_bytes"] == 0
    # The storage service is told the content type; nothing else is decided later.
    assert storage.created[0]["ContentType"] == WAV_MIME


def test_begin_is_idempotent_so_a_lost_client_can_ask_again(storage):
    """The client is not the only place the plan may live."""
    owner = UserFactory()
    key = str(uuid.uuid4())
    first, _ = begin(owner, storage, key=key)
    second, _ = begin(owner, storage, key=key)
    assert first.status_code == second.status_code == 200
    assert first.data["session_id"] == second.data["session_id"]
    # One storage upload, not two: repeating the intent must not pay twice.
    assert len(storage.created) == 1
    assert models.RecordingUploadSession.objects.count() == 1


def test_begin_rejects_a_changed_intent_for_the_same_key(storage):
    owner = UserFactory()
    key = str(uuid.uuid4())
    begin(owner, storage, key=key)
    response, _ = begin(owner, storage, key=key, context="different")
    assert response.status_code == 409
    assert len(storage.created) == 1


def test_begin_refuses_an_extension_the_declared_type_does_not_allow(storage):
    response, _ = begin(
        UserFactory(), storage, name="clip.wav", content_type="video/mp4"
    )
    assert response.status_code == 400
    assert storage.created == []


def test_begin_is_unavailable_when_the_feature_is_off(settings):
    settings.MEETING_FILE_DIRECT_UPLOAD_ENABLED = False
    with mock.patch.object(sessions, "audio_storage") as unused:
        response, _ = begin(UserFactory(), unused)
    assert response.status_code == 503
    unused.assert_not_called()


# --- signing -----------------------------------------------------------------


def test_parts_are_signed_in_a_batch_against_this_uploads_own_id(storage):
    """One request per part would not fit the endpoint's request budget."""
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    response = client_for(owner).post(
        PARTS.format(session_id), {"parts": [1, 2]}, format="json"
    )
    assert response.status_code == 200, response.data
    assert [p["part_number"] for p in response.data["parts"]] == [1, 2]
    assert len(storage.signed) == 2
    for call in storage.signed:
        assert call["method"] == "upload_part"
        assert call["params"]["UploadId"] == "upload-1"
        assert call["params"]["Bucket"] == "private-bucket"
    # The first part is a full part; the last one is whatever is left.
    assert response.data["parts"][0]["expected_bytes"] == sessions.PART_SIZE
    assert response.data["parts"][1]["expected_bytes"] == sessions.PART_SIZE


def test_signing_refuses_a_part_number_the_upload_does_not_have(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    response = client_for(owner).post(
        PARTS.format(session_id), {"parts": [3]}, format="json"
    )
    assert response.status_code == 400
    assert storage.signed == []


def test_a_short_final_part_reports_its_own_expected_length(storage):
    """A file that is not a whole number of parts still has a valid last part."""
    owner = UserFactory()
    odd = sessions.PART_SIZE + 1024
    session_id = begin(owner, storage, size=odd)[0].data["session_id"]
    response = client_for(owner).post(
        PARTS.format(session_id), {"parts": [1, 2]}, format="json"
    )
    assert response.status_code == 200
    assert response.data["parts"][1]["expected_bytes"] == 1024


# --- resuming ----------------------------------------------------------------


def test_resume_reports_what_storage_holds_not_what_the_client_claims(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    # Storage has part 1 only: part 2 was lost in transit.
    storage.parts[1] = ("etag1", sessions.PART_SIZE)
    response = client_for(owner).get(SESSION.format(session_id))
    assert response.status_code == 200
    assert response.data["uploaded"] == [
        {"part_number": 1, "etag": "etag1", "size": sessions.PART_SIZE}
    ]
    assert response.data["uploaded_bytes"] == sessions.PART_SIZE


def test_resume_is_scoped_to_the_owner(storage):
    session_id = begin(UserFactory(), storage)[0].data["session_id"]
    assert client_for(UserFactory()).get(SESSION.format(session_id)).status_code == 404


# --- completing --------------------------------------------------------------


def test_complete_reassembles_then_creates_one_job(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    fill(storage)
    response = client_for(owner).post(
        SESSION.format(session_id), complete_body(storage), format="json"
    )
    assert response.status_code == 202, response.data
    assert response.data["status"] == "queued"
    assert len(storage.completed) == 1
    # Part order is what makes the object correct, so it must be ascending.
    sent = storage.completed[0]["MultipartUpload"]["Parts"]
    assert [p["PartNumber"] for p in sent] == [1, 2]
    job = models.UploadedRecording.objects.get(record_id=response.data["record_id"])
    assert job.record.owner_id == owner.pk
    assert job.size == SIZE


def test_the_record_is_titled_from_the_filename_not_the_uuid_key(storage):
    """The object key is a UUID, so the human name has to survive somewhere."""
    owner = UserFactory()
    session_id = begin(owner, storage, name="Q3 review.wav")[0].data["session_id"]
    fill(storage)
    response = client_for(owner).post(
        SESSION.format(session_id), complete_body(storage), format="json"
    )
    job = models.UploadedRecording.objects.get(record_id=response.data["record_id"])
    assert job.record.title == "Q3 review"
    assert job.storage_name.endswith(".wav")
    # And the worker payload keeps the original name too.
    assert job.configuration["_file"]["name"] == job.storage_name.split("/")[-1]


def test_complete_refuses_an_upload_that_is_missing_a_part(storage):
    """Storage is the authority: a client cannot complete over a hole."""
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    storage.parts[1] = ("etag1", sessions.PART_SIZE)
    # The client claims both parts, but storage only ever received one.
    response = client_for(owner).post(
        SESSION.format(session_id),
        {
            "parts": [
                {"part_number": 1, "etag": "etag1"},
                {"part_number": 2, "etag": "etag2"},
            ]
        },
        format="json",
    )
    assert response.status_code == 400
    assert response.data["code"] == "part_not_uploaded"
    assert storage.completed == []
    assert models.UploadedRecording.objects.count() == 0


def test_complete_refuses_a_part_whose_etag_does_not_match_storage(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    fill(storage)
    body = complete_body(storage)
    body["parts"][0]["etag"] = "tampered"
    response = client_for(owner).post(SESSION.format(session_id), body, format="json")
    assert response.status_code == 400
    assert storage.completed == []


def test_complete_refuses_when_stored_bytes_do_not_add_up_to_the_declaration(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    # Both parts present and honest, but short: the object is smaller than claimed.
    storage.parts[1] = ("etag1", 1024)
    storage.parts[2] = ("etag2", 1024)
    response = client_for(owner).post(
        SESSION.format(session_id), complete_body(storage), format="json"
    )
    assert response.status_code == 400
    assert response.data["code"] == "upload_size_mismatch"
    assert storage.completed == []


def test_completing_twice_replays_the_same_job(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    fill(storage)
    first = client_for(owner).post(
        SESSION.format(session_id), complete_body(storage), format="json"
    )
    second = client_for(owner).post(
        SESSION.format(session_id), complete_body(storage), format="json"
    )
    assert first.status_code == second.status_code == 202
    assert first.data == second.data
    assert models.UploadedRecording.objects.count() == 1


# --- aborting ----------------------------------------------------------------


def test_abort_tells_storage_to_drop_the_incomplete_upload(storage):
    """Leaving it alive keeps billing for parts nobody will ever use."""
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    response = client_for(owner).delete(SESSION.format(session_id))
    assert response.status_code == 204
    assert len(storage.aborted) == 1
    assert storage.aborted[0]["UploadId"] == "upload-1"


def test_an_aborted_session_cannot_be_signed_or_resumed(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    client_for(owner).delete(SESSION.format(session_id))
    signed = client_for(owner).post(
        PARTS.format(session_id), {"parts": [1]}, format="json"
    )
    assert signed.status_code == 400
    assert signed.data["code"] == "session_not_open"


def test_repeating_an_intent_after_an_abort_is_refused_not_silently_restarted(storage):
    """A new upload would be a new intent, so the client has to say so."""
    owner = UserFactory()
    key = str(uuid.uuid4())
    session_id = begin(owner, storage, key=key)[0].data["session_id"]
    client_for(owner).delete(SESSION.format(session_id))
    response, _ = begin(owner, storage, key=key)
    assert response.status_code == 409
    assert len(storage.created) == 1


def test_abort_is_scoped_to_the_owner(storage):
    session_id = begin(UserFactory(), storage)[0].data["session_id"]
    assert (
        client_for(UserFactory()).delete(SESSION.format(session_id)).status_code == 404
    )
    assert storage.aborted == []


# --- planning ----------------------------------------------------------------


def test_part_planning_matches_the_storage_limits():
    assert sessions.part_count(SIZE) == 2
    assert sessions.part_count(sessions.PART_SIZE) == 1
    assert sessions.part_count(sessions.PART_SIZE + 1) == 2
    # A whole number of parts must not round up to a spurious empty final part.
    assert sessions.part_count(sessions.PART_SIZE * 3) == 3


def test_a_file_needing_too_many_parts_is_refused():
    with pytest.raises(ValueError):
        sessions.part_count(sessions.PART_SIZE * (sessions.MAX_PARTS + 1))


def test_complete_response_loss_recovers_without_reassembling_or_duplicating(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    fill(storage)

    def lost(**kwargs):
        storage._complete(**kwargs)
        raise TimeoutError("response lost")

    storage.connection.meta.client.complete_multipart_upload.side_effect = lost
    result = client_for(owner).post(
        SESSION.format(session_id), complete_body(storage), format="json"
    )
    assert result.status_code == 202, result.data
    repeated = client_for(owner).post(
        SESSION.format(session_id), {"parts": []}, format="json"
    )
    assert repeated.data["record_id"] == result.data["record_id"]
    assert len(storage.completed) == models.UploadedRecording.objects.count() == 1


def test_db_failure_preserves_bytes_and_resume_requests_completion_without_puts(
    storage,
):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    fill(storage)
    with mock.patch.object(
        sessions, "_record_job", side_effect=RuntimeError("database unavailable")
    ):
        with pytest.raises(RuntimeError):
            sessions.complete(owner, session_id, complete_body(storage)["parts"])
    assert storage.deleted == []
    assert models.UploadedRecording.objects.count() == 0
    resumed = client_for(owner).get(SESSION.format(session_id))
    assert resumed.status_code == 200
    assert resumed.data["completion_pending"] is True
    assert resumed.data["uploaded_bytes"] == SIZE
    assert models.UploadedRecording.objects.count() == 0  # GET does not enqueue AI.
    result = client_for(owner).post(
        SESSION.format(session_id), {"parts": []}, format="json"
    )
    assert result.status_code == 202, result.data
    assert len(storage.completed) == 1
    assert models.UploadedRecording.objects.count() == 1


def test_completed_object_is_checked_for_exact_size_and_real_media(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    fill(storage)
    session = models.RecordingUploadSession.objects.get(pk=session_id)
    storage.completed.append({"Key": session.storage_name})
    client = client_for(owner)
    storage.parts[1] = ("etag1", 1)
    assert (
        client.post(SESSION.format(session_id), {"parts": []}, format="json").data[
            "code"
        ]
        == "upload_size_mismatch"
    )
    fill(storage)
    storage.connection.meta.client.get_object.side_effect = lambda **_: {
        "Body": io.BytesIO(b"not media")
    }
    assert (
        client.post(SESSION.format(session_id), {"parts": []}, format="json").data[
            "code"
        ]
        == "invalid_media_content"
    )
    assert models.UploadedRecording.objects.count() == 0
    assert (
        client_for(UserFactory())
        .post(SESSION.format(session_id), {"parts": []}, format="json")
        .status_code
        == 404
    )


def test_no_parts_cannot_complete_an_unassembled_object(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    response = client_for(owner).post(SESSION.format(session_id), {"parts": []}, format="json")
    assert response.status_code == 400
    assert response.data["code"] == "incomplete_upload"
    assert models.UploadedRecording.objects.count() == 0


def test_abort_cleans_an_assembled_but_unadopted_object(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    session = models.RecordingUploadSession.objects.get(pk=session_id)
    fill(storage)
    storage.completed.append({"Key": session.storage_name})
    storage.connection.meta.client.abort_multipart_upload.side_effect = ClientError(
        {"Error": {"Code": "NoSuchUpload"}}, "AbortMultipartUpload"
    )
    response = client_for(owner).delete(SESSION.format(session_id))
    assert response.status_code == 204
    assert storage.deleted == [session.storage_name]
    assert client_for(owner).get(SESSION.format(session_id)).status_code == 400


def test_unrelated_completion_marker_does_not_create_a_job(storage):
    owner = UserFactory()
    session_id = begin(owner, storage)[0].data["session_id"]
    session = models.RecordingUploadSession.objects.get(pk=session_id)
    fill(storage)
    storage.completed.append({"Key": session.storage_name})
    storage.created[0]["Metadata"]["upload-intent"] = "different-intent"
    response = client_for(owner).post(SESSION.format(session_id), {"parts": []}, format="json")
    assert response.status_code == 409
    assert models.UploadedRecording.objects.count() == 0
