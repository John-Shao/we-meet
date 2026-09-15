"""File uploads cannot leak sources, duplicate paid tasks or publish partial text."""

import json
import uuid
from datetime import timedelta
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import qwen_filetrans as provider
from core.services import uploaded_recordings as service
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/recording-uploads/"


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_FILE_ASR_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-only"
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)
    with mock.patch.object(service, "available", return_value=True):
        yield


def upload(user, key=None, **extra):
    return client_for(user).post(
        ROOT,
        {
            "key": str(key or uuid.uuid4()),
            "audio": SimpleUploadedFile("meeting.wav", b"test audio", "audio/wav"),
            **extra,
        },
        format="multipart",
    )


def job_for(user):
    response = upload(user)
    assert response.status_code == 202, response.data
    return models.UploadedRecording.objects.get(record_id=response.data["record_id"])


def due(job):
    models.UploadedRecording.objects.filter(pk=job.pk).update(
        next_poll_at=timezone.now() - timedelta(seconds=1)
    )


def test_upload_idempotency_and_owner_only_access():
    owner = UserFactory()
    key = uuid.uuid4()
    first = upload(owner, key)
    assert first.status_code == 202, first.data
    assert upload(owner, key).data == first.data
    assert models.UploadedRecording.objects.count() == 1
    path = ROOT + first.data["record_id"] + "/"
    assert client_for(UserFactory()).get(path).status_code == 404
    assert (
        client_for(UserFactory()).post(path, {"attempt": 1}, format="json").status_code
        == 404
    )
    public = client_for(owner).get(path).json()
    assert (
        not {"storage_name", "checksum", "configuration", "provider_task_id"}
        & public.keys()
    )
    assert upload(owner, key, context="different").status_code == 409
    assert upload(owner).status_code == 409


def test_disabled_and_invalid_uploads_do_not_create_jobs(settings):
    owner = UserFactory()
    with mock.patch.object(service, "available", return_value=False):
        assert upload(owner).status_code == 503
    settings.MEETING_FILE_ASR_MAX_BYTES = 3
    assert upload(owner).status_code == 413
    settings.MEETING_FILE_ASR_MAX_BYTES = 100000
    assert upload(owner, context="x" * 401).status_code == 400
    assert (
        upload(owner, hotwords="\n".join(str(n) for n in range(101))).status_code == 400
    )
    assert upload(owner, audio=SimpleUploadedFile("bad.exe", b"x")).status_code == 400
    assert not models.UploadedRecording.objects.exists()


def test_submission_is_fenced_and_lost_response_requires_explicit_retry():
    job = job_for(UserFactory())
    claimed = service.claim(job.pk)
    assert claimed.status == "submitting"
    assert service.claim(job.pk) is None
    models.UploadedRecording.objects.filter(pk=job.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    assert service.claim(job.pk) is None
    job.refresh_from_db()
    assert job.error_code == "submission_unknown"
    path = ROOT + str(job.record_id) + "/"
    client = client_for(job.record.owner)
    assert client.post(path, {"attempt": 1}, format="json").status_code == 202
    assert client.post(path, {"attempt": 1}, format="json").status_code == 409


def test_worker_submits_once_and_publishes_complete_originals():
    job = job_for(UserFactory())
    storage = mock.Mock()
    storage._normalize_name.side_effect = lambda name: name
    storage.bucket_name = "private"
    storage.location = ""
    storage.connection.meta.client.generate_presigned_url.return_value = (
        "https://private.oss-cn-beijing.aliyuncs.com/audio.wav?signature=test"
    )
    with (
        mock.patch.object(service, "audio_storage", return_value=storage),
        mock.patch.object(provider, "submit", return_value="provider-task") as submit,
    ):
        service.process(job.pk)
        service.process(job.pk)
    assert submit.call_count == 1
    due(job)
    with mock.patch.object(provider, "poll", return_value=None) as poll:
        service.process(job.pk)
    poll.assert_called_once_with("provider-task")
    due(job)
    result = {
        "transcripts": [
            {"sentences": [{"text": "Hello", "begin_time": 10, "end_time": 900}]}
        ]
    }
    with mock.patch.object(provider, "poll", return_value=result):
        service.process(job.pk)
    job.refresh_from_db()
    assert job.status == "succeeded"
    assert job.record.original_segments.get().text == "Hello"
    assert job.record.revision == 2
    path = f"/api/v1.0/meeting-records/{job.record_id}/"
    record = client_for(job.record.owner).get(path).json()
    assert record["capture_id"] is None
    originals = client_for(job.record.owner).get(path + "original-segments/").json()
    assert originals["results"][0]["text"] == "Hello"


def test_invalid_result_publishes_nothing():
    job = job_for(UserFactory())
    models.UploadedRecording.objects.filter(pk=job.pk).update(
        status="running", provider_task_id="test"
    )
    result = {
        "transcripts": [
            {
                "sentences": [
                    {"text": "Valid", "begin_time": 0, "end_time": 100},
                    {"text": "Bad", "begin_time": 500, "end_time": 100},
                ]
            }
        ]
    }
    with mock.patch.object(provider, "poll", return_value=result):
        service.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed"
    assert not job.record.original_segments.exists()


def test_revoked_owner_cannot_continue_provider_work():
    job = job_for(UserFactory())
    models.User.objects.filter(pk=job.record.owner_id).update(is_active=False)
    with mock.patch.object(provider, "submit") as submit:
        service.process(job.pk)
    submit.assert_not_called()
    job.refresh_from_db()
    assert job.status == "failed"


def test_provider_payload_uses_file_urls_context_and_vocabulary():
    with mock.patch.object(
        provider, "request_json", return_value={"output": {"task_id": "task"}}
    ) as request:
        assert (
            provider.submit(
                "https://audio.invalid/a.wav",
                {"context": "Context", "hotwords": ["Qwen"]},
            )
            == "task"
        )
    payload = request.call_args.kwargs["payload"]
    assert payload["model"] == "qwen-audio-3.0-asr-flash-filetrans"
    assert payload["input"]["file_urls"] == ["https://audio.invalid/a.wav"]
    assert payload["input"]["context"][0]["content"][0] == {
        "type": "input_text",
        "text": "Context",
    }
    assert payload["parameters"]["vocabulary"] == {"Qwen": 3}


@pytest.mark.parametrize("status", ["FAILED", "UNKNOWN", "CANCELED"])
def test_provider_terminal_failure_is_not_success(status):
    with (
        mock.patch.object(
            provider, "request_json", return_value={"output": {"task_status": status}}
        ),
        pytest.raises(provider.FileTranscriptionError),
    ):
        provider.poll("task")


def test_result_download_does_not_receive_bearer_token():
    result = {
        "output": {
            "task_status": "SUCCEEDED",
            "results": [
                {
                    "subtask_status": "SUCCEEDED",
                    "transcription_url": "https://results.oss-cn-beijing.aliyuncs.com/t.json",
                }
            ],
        }
    }
    with mock.patch.object(
        provider, "request_json", side_effect=[result, {"transcripts": []}]
    ) as request:
        provider.poll("task")
    assert request.call_args.kwargs["authenticated"] is False


def test_http_contract_and_credentials_do_not_follow_redirects():
    response = mock.MagicMock()
    response.status_code = 200
    response.iter_content.return_value = [
        json.dumps({"output": {"task_id": "task"}}).encode()
    ]
    response.__enter__.return_value = response
    with mock.patch.object(
        provider.requests, "request", return_value=response
    ) as request:
        provider.submit("https://audio.invalid/a.wav", {})
    assert request.call_args.kwargs["headers"]["X-DashScope-Async"] == "enable"
    assert request.call_args.kwargs["allow_redirects"] is False
