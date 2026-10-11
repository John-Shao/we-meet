"""Real DB and local private media preparation; Qwen is always a synthetic stub."""

from datetime import timedelta
from unittest.mock import Mock
from uuid import uuid4

from django.core.files.storage import default_storage
from django.utils import timezone

import pytest
import requests
from botocore.exceptions import ClientError, EndpointConnectionError

from core import models
from core.services import capture_audio_cleanup, record_purge
from core.services import capture_diarization as control
from core.services import capture_diarization_inputs as inputs
from core.services import capture_diarization_objects as objects
from core.services import capture_diarization_worker as worker
from core.services.meeting_records import RecordConflict
from core.services.voiceprint_media_process import MediaError
from core.tests.services.test_capture_diarization import enabled, prepare, source
from core.tests.test_services_capture_diarization_pcm import private_s3

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def worker_options(enabled, settings):
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "synthetic-provider-key"
    settings.MEETING_CAPTURE_DIARIZATION_BUCKET_NAME = ""
    settings.MEETING_CAPTURE_DIARIZATION_DAILY_LIMIT = 3


def pipeline(state, monkeypatch, *, text=False, timed=True):
    owner, capture, parent = source(timed=timed)
    if text:
        models.MeetingRecord.objects.filter(pk=capture.record_id).update(
            retention_mode="text"
        )
        capture.record.refresh_from_db()
    for chunk in capture.audio_chunks.all():
        with default_storage.open(chunk.object_key, "rb") as stream:
            state.data[chunk.object_key] = stream.read()
    monkeypatch.setattr(inputs, "audio_storage", lambda: state.storage)
    monkeypatch.setattr(objects, "audio_storage", lambda: state.storage)
    job = prepare(owner, capture)
    submit = Mock(return_value="synthetic-task")
    monkeypatch.setattr(worker.provider, "submit", submit)
    return owner, capture, parent, job, submit


def ready(job):
    models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(
        next_poll_at=timezone.now() - timedelta(seconds=1)
    )


def result():
    return {
        "properties": {
            "audio_format": "pcm_s16le",
            "channels": [0],
            "original_sampling_rate": 16000,
            "original_duration_in_milliseconds": 1000,
        },
        "transcripts": [
            {
                "channel_id": 0,
                "sentences": [
                    {
                        "begin_time": 0,
                        "end_time": 500,
                        "speaker_id": 0,
                        "text": "Wrong provider text",
                    },
                    {
                        "begin_time": 500,
                        "end_time": 1000,
                        "speaker_id": 1,
                        "text": "Do not publish",
                    },
                ],
            }
        ],
        "billed_seconds": 0.5,
    }


@pytest.mark.parametrize("stage", ["adopt", "selected"])
def test_null_version_receipt_cannot_be_adopted_or_selected(
    private_s3, monkeypatch, stage
):
    _, _, _, job, submit = pipeline(private_s3, monkeypatch)
    identifier = uuid4()
    control.claim(job.pk, identifier)
    row = inputs.reserve(job.pk, identifier)
    receipt = {
        "schema": 1,
        "kind": "s3_object",
        "key": objects.name(row),
        "size": 44 + row.duration_ms * 32,
        "sha256": "",
        "etag": '"fixed-token"',
        "version_id": "null",
    }
    if stage == "adopt":
        with pytest.raises(MediaError, match="storage_response_invalid"):
            inputs._adopt(
                row, identifier, {"receipt": receipt, "sha256": "a" * 64}, "a" * 64
            )
        row.refresh_from_db()
        job.refresh_from_db()
        assert row.status == "preparing" and job.input_id is None
    else:
        inputs._adopt(
            row,
            identifier,
            {"receipt": {**receipt, "version_id": "fixed-version"}, "sha256": "a" * 64},
            "a" * 64,
        )
        models.CaptureDiarizationInput.objects.filter(pk=row.pk).update(receipt=receipt)
        job.refresh_from_db()
        with pytest.raises(MediaError, match="source_integrity_unavailable"):
            objects.selected(job)
    assert not private_s3.requests
    submit.assert_not_called()


def test_real_preparation_pins_version_and_polls_without_repeating_post(
    private_s3, monkeypatch
):
    _, capture, parent, job, submit = pipeline(private_s3, monkeypatch)
    poll = Mock(side_effect=[None, result()])
    monkeypatch.setattr(worker.provider, "poll", poll)
    worker.process(job.pk)
    job.refresh_from_db()
    assert job.phase == "polling" and job.input.status == "ready", job.error_code
    assert job.preparation_attempts == 1
    assert "versionId=fixed-version" in submit.call_args.args[0]
    assert submit.call_args.args[1] == {"diarization": True}
    for _ in range(2):
        ready(job)
        worker.process(job.pk)
    worker.process(job.pk)
    job.refresh_from_db()
    capture.refresh_from_db()
    parent.refresh_from_db()
    assert job.status == "succeeded" and job.phase == "completed"
    assert capture.active_diarization_id == job.pk
    assert list(
        job.originals.order_by("source_sequence").values_list("text", flat=True)
    ) == ["One. ", "Two."]
    assert parent.text == "One. Two."
    assert job.provider_report == {"task_id": "synthetic-task", "billed_seconds": 0.5}
    assert submit.call_count == 1 and poll.call_count == 2
    assert [item[0] for item in private_s3.requests].count("PUT") == 1
    assert all(
        item[2] == {"versionId": ["fixed-version"]}
        for item in private_s3.requests
        if item[0] == "HEAD"
    )


def test_ambiguous_submission_never_reposts(private_s3, monkeypatch):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    submit.side_effect = requests.Timeout("synthetic uncertainty")
    worker.process(job.pk)
    ready(job)
    worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.error_code == "submission_unknown"
    assert job.begun_at and not job.provider_task_id
    assert submit.call_count == 1


def test_expired_submitting_fence_cannot_be_claimed_for_another_post(
    private_s3, monkeypatch
):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    identifier = uuid4()
    claimed = control.claim(job.pk, identifier)
    inputs.prepare(claimed, identifier, authorized=lambda: worker.live(claimed))
    worker.begin(job.pk, identifier)
    models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.error_code == "submission_unknown"
    submit.assert_not_called()
    worker.acknowledge(job.pk, identifier, "late-receipt")
    job.refresh_from_db()
    assert job.status == "failed" and job.provider_task_id == "late-receipt"


def test_late_paid_receipt_survives_record_revision_change(private_s3, monkeypatch):
    _, capture, _, job, submit = pipeline(private_s3, monkeypatch)

    def revoke(*_args):
        models.MeetingRecord.objects.filter(pk=capture.record_id).update(
            revision=job.source_revision + 1
        )
        return "late-task"

    submit.side_effect = revoke
    worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.provider_task_id == "late-task"
    assert not job.originals.exists()
    assert submit.call_count == 1


def test_preparation_transient_failures_are_bounded_without_any_post(
    private_s3, monkeypatch
):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    invoke = Mock(side_effect=MediaError("media_storage_unavailable", retryable=True))
    monkeypatch.setattr(inputs, "invoke", invoke)
    for _ in range(5):
        ready(job)
        worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.preparation_attempts == 3
    assert job.error_code == "capture_diarization_retry_exhausted"
    assert job.media_inputs.count() == 3 and invoke.call_count == 3
    submit.assert_not_called()


def test_poll_network_failures_are_bounded_and_never_repost(private_s3, monkeypatch):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    poll = Mock(side_effect=requests.ConnectionError("synthetic GET failure"))
    monkeypatch.setattr(worker.provider, "poll", poll)
    worker.process(job.pk)
    for _ in range(5):
        ready(job)
        worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.poll_failures == 3
    assert job.error_code == "capture_diarization_retry_exhausted"
    assert submit.call_count == 1 and poll.call_count == 3


def test_prepared_input_head_retries_are_bounded_without_reupload_or_post(
    private_s3, monkeypatch
):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    head = Mock(
        side_effect=EndpointConnectionError(endpoint_url="https://synthetic.invalid")
    )
    monkeypatch.setattr(private_s3.storage.connection.meta.client, "head_object", head)
    for _ in range(5):
        ready(job)
        worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.preparation_attempts == 3
    assert job.error_code == "capture_diarization_retry_exhausted"
    assert job.input.status == "ready" and job.media_inputs.count() == 1
    assert head.call_count == 3
    assert [request[0] for request in private_s3.requests].count("PUT") == 1
    submit.assert_not_called()


def test_transient_fixed_version_head_failure_retries_get_only(private_s3, monkeypatch):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    worker.process(job.pk)
    head = Mock(
        side_effect=EndpointConnectionError(endpoint_url="https://synthetic.invalid")
    )
    monkeypatch.setattr(private_s3.storage.connection.meta.client, "head_object", head)
    poll = Mock()
    monkeypatch.setattr(worker.provider, "poll", poll)
    for _ in range(3):
        ready(job)
        worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.poll_failures == 3
    assert submit.call_count == 1 and head.call_count == 3
    poll.assert_not_called()


def test_missing_fixed_version_fails_without_poll_or_reconstruction(
    private_s3, monkeypatch
):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    worker.process(job.pk)
    head = Mock(
        side_effect=ClientError(
            {
                "Error": {"Code": "NoSuchVersion"},
                "ResponseMetadata": {"HTTPStatusCode": 404},
            },
            "HeadObject",
        )
    )
    monkeypatch.setattr(private_s3.storage.connection.meta.client, "head_object", head)
    poll = Mock()
    monkeypatch.setattr(worker.provider, "poll", poll)
    ready(job)
    worker.process(job.pk)
    job.refresh_from_db()
    assert (
        job.status == "failed"
        and job.error_code == "capture_diarization_media_unavailable"
    )
    assert job.media_inputs.count() == 1 and submit.call_count == 1
    poll.assert_not_called()


@pytest.mark.parametrize(
    "field,value",
    [
        ("audio_format", "mp3"),
        ("channels", [True]),
        ("original_sampling_rate", 24000),
        ("original_duration_in_milliseconds", 9999),
    ],
)
def test_invalid_provider_metadata_cannot_publish_but_keeps_usage_receipt(
    private_s3, monkeypatch, field, value
):
    *_, job, _ = pipeline(private_s3, monkeypatch)
    output = result()
    output["properties"][field] = value
    monkeypatch.setattr(worker.provider, "poll", Mock(return_value=output))
    worker.process(job.pk)
    ready(job)
    worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and not job.originals.exists()
    assert job.provider_report["billed_seconds"] == 0.5


def test_feature_disable_prevents_private_io_and_paid_submission(
    private_s3, monkeypatch, settings
):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    settings.MEETING_CAPTURE_DIARIZATION_ENABLED = False
    worker.process(job.pk)
    assert worker.due() == [] and not private_s3.requests
    submit.assert_not_called()


def test_daily_limit_counts_failed_attempts_and_preserves_nonce_receipts():
    owner, capture, _ = source()
    jobs = []
    for _ in range(3):
        job = prepare(owner, capture)
        jobs.append(job)
        models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(
            status="failed", phase="failed"
        )
    with pytest.raises(RecordConflict, match="budget"):
        prepare(owner, capture)
    replay, created = control.prepare(
        capture.pk, owner, jobs[0].key, expected_revision=jobs[0].source_revision
    )
    assert not created and replay.pk == jobs[0].pk


def test_text_audio_cleanup_waits_for_active_diarization(private_s3, monkeypatch):
    _, capture, _, job, _ = pipeline(private_s3, monkeypatch, text=True)
    assert capture_audio_cleanup.schedule(capture.pk) is None
    models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(
        status="failed", phase="failed"
    )
    assert capture_audio_cleanup.schedule(capture.pk) is not None


def test_cleanup_waits_for_writer_drain_and_erases_exact_versions_only(
    private_s3, monkeypatch
):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    submit.side_effect = requests.Timeout()
    worker.process(job.pk)
    row = job.media_inputs.get()
    client = private_s3.storage.connection.meta.client
    key = "prefix/" + objects.name(row)
    listing = Mock(
        side_effect=[
            {
                "IsTruncated": False,
                "Versions": [
                    {"Key": key, "VersionId": "v1"},
                    {"Key": key + "-neighbor", "VersionId": "keep"},
                ],
                "DeleteMarkers": [{"Key": key, "VersionId": "marker"}],
            },
            {
                "IsTruncated": False,
                "Versions": [{"Key": key + "-neighbor", "VersionId": "keep"}],
            },
        ]
    )
    delete = Mock(return_value={})
    monkeypatch.setattr(client, "list_object_versions", listing)
    monkeypatch.setattr(client, "delete_objects", delete)
    assert row.pk not in inputs.due()
    assert inputs.purge(row.pk).status == "ready"
    listing.assert_not_called()
    models.CaptureDiarizationInput.objects.filter(pk=row.pk).update(
        write_until=timezone.now() - timedelta(seconds=1)
    )
    assert row.pk in inputs.due()
    cleaned = inputs.purge(row.pk)
    assert cleaned.status == "deleted" and cleaned.deleted_at
    assert delete.call_args.kwargs["Delete"]["Objects"] == [
        {"Key": key, "VersionId": "v1"},
        {"Key": key, "VersionId": "marker"},
    ]


def test_unconfirmed_version_erasure_retains_cleanup_receipt(private_s3, monkeypatch):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    submit.side_effect = requests.Timeout()
    worker.process(job.pk)
    row = job.media_inputs.get()
    models.CaptureDiarizationInput.objects.filter(pk=row.pk).update(
        write_until=timezone.now() - timedelta(seconds=1)
    )
    client = private_s3.storage.connection.meta.client
    page = {
        "IsTruncated": True,
        "Versions": [{"Key": "prefix/" + objects.name(row), "VersionId": "remains"}],
    }
    monkeypatch.setattr(client, "list_object_versions", Mock(return_value=page))
    monkeypatch.setattr(client, "delete_objects", Mock(return_value={}))
    cleaned = inputs.purge(row.pk)
    assert cleaned.status == "deleting" and not cleaned.deleted_at
    assert cleaned.next_cleanup_at > timezone.now()


def test_reserved_input_survives_job_deletion_for_orphan_cleanup(
    private_s3, monkeypatch
):
    *_, job, _ = pipeline(private_s3, monkeypatch)
    identifier = uuid4()
    control.claim(job.pk, identifier)
    row = inputs.reserve(job.pk, identifier)
    job.delete()
    row.refresh_from_db()
    assert row.job_id is None
    models.CaptureDiarizationInput.objects.filter(pk=row.pk).update(
        write_until=timezone.now() - timedelta(seconds=1)
    )
    assert row.pk in inputs.due()


def test_cleanup_resweeps_a_late_object_after_confirmed_erasure(
    private_s3, monkeypatch
):
    *_, job, submit = pipeline(private_s3, monkeypatch)
    submit.side_effect = requests.Timeout()
    worker.process(job.pk)
    row = job.media_inputs.get()
    models.CaptureDiarizationInput.objects.filter(pk=row.pk).update(
        write_until=timezone.now() - timedelta(seconds=1),
        status="deleted",
        deleted_at=timezone.now() - timedelta(minutes=10),
        next_cleanup_at=timezone.now() - timedelta(seconds=1),
    )
    client = private_s3.storage.connection.meta.client
    key = "prefix/" + objects.name(row)
    listing = Mock(
        side_effect=[
            {"IsTruncated": False, "Versions": [{"Key": key, "VersionId": "late-put"}]},
            {"IsTruncated": False},
        ]
    )
    deletion = Mock(return_value={})
    monkeypatch.setattr(client, "list_object_versions", listing)
    monkeypatch.setattr(client, "delete_objects", deletion)
    assert row.pk in inputs.due()
    assert inputs.purge(row.pk).status == "deleted"
    assert deletion.call_args.kwargs["Delete"]["Objects"] == [
        {"Key": key, "VersionId": "late-put"}
    ]


def test_record_purge_waits_for_physical_derivative_erasure(
    private_s3, monkeypatch, settings
):
    owner, capture, _, job, submit = pipeline(private_s3, monkeypatch)
    submit.side_effect = requests.Timeout()
    worker.process(job.pk)
    row = job.media_inputs.get()
    settings.MEETING_RECORD_PURGE_ENABLED = True
    settings.MEETING_RECORD_TRASH_ENABLED = True
    models.MeetingRecord.objects.filter(pk=capture.record_id).update(
        deleted_at=timezone.now()
    )
    capture.record.refresh_from_db()
    purge = record_purge.request(
        capture.record_id, owner, capture.record.lifecycle_revision
    )
    record_purge.step(purge.pk)  # Original capture chunk.
    record_purge.step(purge.pk)  # Derivative is still draining.
    assert models.MeetingRecord.objects.filter(pk=capture.record_id).exists()
    assert row.status == "ready"
    client = private_s3.storage.connection.meta.client
    monkeypatch.setattr(
        client, "list_object_versions", Mock(return_value={"IsTruncated": False})
    )
    models.CaptureDiarizationInput.objects.filter(pk=row.pk).update(
        write_until=timezone.now() - timedelta(seconds=1)
    )
    models.MeetingRecordPurge.objects.filter(pk=purge.pk).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1)
    )
    record_purge.step(purge.pk)
    assert models.MeetingRecord.objects.filter(pk=capture.record_id).exists()
    assert models.CaptureDiarizationInput.objects.get(pk=row.pk).status == "deleted"
    record_purge.step(purge.pk)
    assert not models.MeetingRecord.objects.filter(pk=capture.record_id).exists()
    row.refresh_from_db()
    assert row.job_id is None and row.status == "deleted"
