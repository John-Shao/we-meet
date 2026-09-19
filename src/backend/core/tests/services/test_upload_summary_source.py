"""Published imports share the summary lane without acquiring capture-ASR jobs."""

import uuid
from unittest.mock import patch

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_record_qa as qa
from core.services import uploaded_recordings
from core.services.meeting_records import (
    RecordConflict,
    can_edit_transcript,
    record_capabilities,
)
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
    summary_readiness,
)
from core.tests.services.test_meeting_record_qa import output as answer_output
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_requests import payload, post
from core.tests.services.test_meeting_summary_versions import output
from core.tests.services.test_uploaded_recordings import enabled, job_for, upload

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def summary_enabled(settings):
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = True
    # Imports are not native capture sessions and must not depend on these gates.
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = False
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = False


def published():
    owner = UserFactory()
    job = job_for(owner)
    job.status = "running"
    job.lease_id = uuid.uuid4()
    job.save()
    uploaded_recordings.finish(
        job,
        [
            {
                "speaker": "1",
                "start_ms": 10,
                "end_ms": 900,
                "text": "Original words",
                "language": "en",
            }
        ],
    )
    job.refresh_from_db()
    job.record.refresh_from_db()
    return owner, job


def test_upload_correction_to_public_summary_and_immutable_citation(settings):
    owner, upload_job = published()
    record = upload_job.record
    assert record_capabilities(record, owner)["generate_summary"]
    path = f"/api/v1.0/meeting-records/{record.pk}/"
    row = client_for(owner).get(path + "original-segments/").data["results"][0]
    assert row["can_correct"]
    response = client_for(owner).patch(
        path + f"original-segments/{row['id']}/",
        {"text": "Corrected upload", "expected_revision": 0},
        format="json",
    )
    assert response.status_code == 200
    assert summary_readiness(record)["ready_stages"] == ["final"]
    response = post(owner, record, payload(record))
    assert response.status_code == 202, response.data
    job = record.processing_jobs.get(kind="summary")
    assert job.input_snapshot.segments[0]["text"] == "Corrected upload"
    with patch("core.services.meeting_summary_versions.LLMClient") as llm:
        llm.return_value.chat.return_value = output(job)
        version_id = execute_summary_job(job.pk, job.attempt)
    assert version_id
    version = models.MeetingSummaryVersion.objects.get(pk=version_id)
    assert version.content["decisions"][0]["source_refs"][0]["segment_revision"] == 2
    assert (
        client_for(owner)
        .get(path + f"transcript-versions/{job.input_snapshot_id}/")
        .status_code
        == 200
    )
    assert not models.CaptureTranscriptionJob.objects.exists()
    settings.MEETING_RECORD_QA_ENABLED = True
    question, _ = qa.prepare(
        record.pk,
        owner,
        uuid.uuid4(),
        {
            "snapshot_id": str(job.input_snapshot_id),
            "question": "What was said?",
        },
    )
    with patch("core.services.meeting_record_qa.LLMClient") as llm:
        llm.return_value.chat.return_value = answer_output(job.input_snapshot)
        answer = qa.execute(question.pk)
    assert answer.status == "succeeded"
    assert answer.content["source_refs"][0]["segment_revision"] == 2


@pytest.mark.parametrize("status", ["queued", "running", "failed"])
def test_unpublished_import_is_not_summary_input(status):
    _, job = published()
    job.status = status
    job.save()
    assert not summary_readiness(job.record)["ready_stages"]
    with pytest.raises(RecordConflict):
        prepare_summary_job(job.record_id)


def test_missing_published_rows_or_changed_provenance_are_rejected():
    _, job = published()
    job.record.original_segments.all().delete()
    with pytest.raises(RecordConflict):
        prepare_summary_job(job.record_id)


def test_editor_permission_survives_disabled_ai_and_does_not_grant_readers_write(
    settings,
):
    owner, job = published()
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = False
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = False
    settings.CELERY_ENABLED = False
    assert can_edit_transcript(job.record, owner)
    caps = record_capabilities(job.record, owner)
    assert caps["edit"] and not caps["generate_summary"]
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=job.record, user=reader, read_summary=True, read_transcript=True
    )
    assert not can_edit_transcript(job.record, reader)
    assert not record_capabilities(job.record, reader)["edit"]
    path = f"/api/v1.0/meeting-records/{job.record_id}/original-segments/"
    row = client_for(reader).get(path).data["results"][0]
    assert not row["can_correct"]
    assert (
        client_for(reader)
        .patch(
            path + row["id"] + "/",
            {"text": "forbidden", "expected_revision": 0},
            format="json",
        )
        .status_code
        == 403
    )
    assert (
        client_for(owner)
        .patch(
            path + row["id"] + "/",
            {"text": "manual edit", "expected_revision": 0},
            format="json",
        )
        .status_code
        == 200
    )


def test_upload_replay_after_publication_preserves_idempotency():
    owner, job = published()
    replay = upload(owner, job.key)
    assert replay.status_code == 202
    assert replay.data["record_id"] == str(job.record_id)
    assert models.UploadedRecording.objects.count() == 1


def test_transcript_reader_cannot_request_paid_generation():
    _, job = published()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=job.record, user=reader, read_summary=True, read_transcript=True
    )
    assert post(reader, job.record, payload(job.record)).status_code == 403
    assert not job.record.processing_jobs.exists()


def test_previously_published_upload_without_count_metadata_is_compatible():
    _, job = published()
    job.configuration.pop("_published")
    job.save()
    assert (
        prepare_summary_job(job.record_id).input_snapshot.segments[0]["text"]
        == "Original words"
    )
