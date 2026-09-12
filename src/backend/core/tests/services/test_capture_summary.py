"""Standalone summaries use published ASR originals and existing snapshot contracts."""

import json
import uuid
from unittest.mock import patch

import pytest

from core import models
from core.factories import MembershipFactory, UserFactory
from core.services import meeting_record_qa, meeting_summary_review
from core.services.meeting_records import RecordConflict, can_generate_summary
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
    source_is_current,
    summary_readiness,
)
from core.tests.services.test_capture_transcription import (
    acknowledge,
    agent,
    claim,
    control,
    final,
    finish,
    request_job,
    running,
    saved,
)
from core.tests.services.test_meeting_record_qa import output as question_output
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_requests import payload, post
from core.tests.services.test_meeting_summary_versions import output

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "summary-test-only"
    settings.AGENT_INTERNAL_API_TOKEN = "asr-test-only"
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def published():
    user, capture, worker, asr = running()
    assert final(asr["id"], worker)[0].status_code == 201
    acknowledge(asr, worker)
    assert finish(asr["id"], worker).data["status"] == "succeeded"
    capture.record.refresh_from_db()
    return user, capture, asr


def test_public_native_summary_keeps_real_source_identity_and_exact_references():
    user, capture, asr = published()
    record = capture.record
    assert record.meeting_session_id is None
    response = post(user, record, payload(record))
    assert response.status_code == 202, response.data
    job = record.processing_jobs.get()
    snapshot = job.input_snapshot
    assert snapshot.segments[0]["segment_revision"] == 1
    assert snapshot.segments[0]["speaker_identity"] == ""
    assert snapshot.delivery["capture_transcriptions"][0]["id"] == asr["id"]
    assert summary_readiness(record)["ready_stages"] == ["final"]
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        version_id = execute_summary_job(job.pk, 1)
    assert version_id
    version = models.MeetingSummaryVersion.objects.get(pk=version_id)
    assert version.input_snapshot_id == snapshot.pk
    assert not models.MeetingSession.objects.exists()
    result = client_for(user).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-versions/"
    )
    assert (
        result.status_code == 200
        and result.data["results"][0]["asr_status"] == "finished"
    )


def test_only_current_owner_can_spend_and_rollout_off_revokes_generation(settings):
    user, capture, _ = published()
    other = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=capture.record, user=other, read_summary=True, read_transcript=True
    )
    assert can_generate_summary(capture.record, user)
    assert not can_generate_summary(capture.record, other)
    assert post(other, capture.record, payload(capture.record)).status_code == 403
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = False
    assert not can_generate_summary(capture.record, user)
    assert not summary_readiness(capture.record)["ready_stages"]


def test_partial_or_empty_asr_cannot_become_a_summary():
    _, capture, worker, asr = running()
    assert final(asr["id"], worker)[0].status_code == 201
    assert not summary_readiness(capture.record)["ready_stages"]
    assert finish(asr["id"], worker).data["status"] == "incomplete"
    with pytest.raises(RecordConflict):
        prepare_summary_job(capture.record_id)


def test_retranscription_changes_source_without_mutating_previous_snapshot():
    user, capture, asr = published()
    job = prepare_summary_job(capture.record_id)
    old = job.input_snapshot.segments
    assert request_job(user, capture, expected=asr["id"]).status_code == 201
    worker, second = claim()
    assert control(second["id"], worker, "begin").status_code == 200
    assert final(second["id"], worker, text="Changed source")[0].status_code == 201
    assert source_is_current(job)
    acknowledge(second, worker)
    assert finish(second["id"], worker).data["status"] == "succeeded"
    assert not source_is_current(job)
    job.refresh_from_db()
    assert job.status == "canceled"
    assert job.input_snapshot.segments == old
    fresh = prepare_summary_job(capture.record_id)
    assert fresh.input_snapshot.segments[0]["text"] == "Changed source"


def test_out_of_band_original_change_blocks_paid_summary():
    _, capture, _ = published()
    models.MeetingOriginalSegment.objects.filter(record=capture.record).update(
        text="Changed outside source contract"
    )
    with pytest.raises(RecordConflict):
        prepare_summary_job(capture.record_id)


def test_incomplete_audio_remains_partial_in_summary_even_when_asr_finished():
    user, capture = saved(gaps=True)
    assert request_job(user, capture, allow=True).status_code == 201
    worker, asr = claim()
    assert control(asr["id"], worker, "begin").status_code == 200
    assert final(asr["id"], worker)[0].status_code == 201
    for index, chunk in enumerate(asr["inputs"]["chunks"], 1):
        assert (
            control(
                asr["id"], worker, "ack_input", index=index, checksum=chunk["checksum"]
            ).status_code
            == 200
        )
    response = agent(
        f"{asr['id']}/finish/",
        {
            "worker_id": str(worker),
            "provider_finished": True,
            "final_sequence": 1,
            "tasks": [
                {
                    "task_id": str(uuid.uuid4()),
                    "finished": True,
                    "input_samples": 16000,
                    "billed_seconds": None,
                }
                for _ in range(2)
            ],
        },
    )
    assert response.data["status"] == "succeeded"
    job = prepare_summary_job(capture.record_id)
    assert job.input_snapshot.delivery["status"] == "incomplete"
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        assert execute_summary_job(job.pk, 1)
    job.refresh_from_db()
    assert job.status == "partial"


def test_successful_silent_asr_has_no_summary_input():
    _, capture, worker, asr = running()
    acknowledge(asr, worker)
    assert finish(asr["id"], worker, count=0).data["status"] == "succeeded"
    assert not summary_readiness(capture.record)["ready_stages"]


def test_native_capture_does_not_advertise_online_staged_automation(settings):
    user, capture, _ = published()
    settings.MEETING_STAGED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_AUTOMATION_ENABLED = True
    path = f"/api/v1.0/meeting-records/{capture.record_id}/summary-automation/"
    assert client_for(user).get(path).data["available"] is False
    response = client_for(user).post(
        path,
        {"enabled": True, "expected_revision": 0},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 403


def test_native_summary_supports_human_review_and_private_snapshot_questions(settings):
    settings.MEETING_RECORD_QA_ENABLED = True
    settings.MEETING_SUMMARY_REVIEW_ENABLED = True
    user, capture, _ = published()
    job = prepare_summary_job(capture.record_id)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        version_id = execute_summary_job(job.pk, 1)
    content = json.loads(output(job))
    content["overview"] = "Human corrected overview"
    review, _, _ = meeting_summary_review.save_review(
        capture.record_id,
        user,
        uuid.uuid4(),
        {
            "base_summary_id": str(version_id),
            "expected_revision": 0,
            "replace_base": False,
            "content": content,
        },
    )
    assert review.content["overview"] == "Human corrected overview"
    MembershipFactory(user=user, is_primary=True)
    question, _ = meeting_record_qa.prepare(
        capture.record_id,
        user,
        uuid.uuid4(),
        {
            "snapshot_id": str(job.input_snapshot_id),
            "question": "What was agreed?",
        },
    )

    def answer(**kwargs):
        kwargs["usage_sink"](
            model_code="qwen3.8-flash", input_tokens=10, output_tokens=5
        )
        return question_output(job.input_snapshot)

    with patch("core.services.meeting_record_qa.LLMClient") as client:
        client.return_value.chat.side_effect = answer
        assert meeting_record_qa.execute(question.pk).status == "succeeded"
    usage = models.AIUsageRecord.objects.get(ref_type="record_question")
    assert usage.user_id == user.pk and usage.organization_id is None
    state = client_for(user).get(
        f"/api/v1.0/capture-sessions/{capture.pk}/transcription/"
    )
    assert state.data["summary_available"] is True
