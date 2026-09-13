"""Live standalone drafts keep generation, source integrity and explicit consent."""

import uuid
from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import capture_transcription
from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_automation import control_automation, tick_automation
from core.services.meeting_summary_versions import (
    prepare_summary_job,
    source_is_current,
    summary_readiness,
)
from core.tests.services.test_capture_audio import seal, upload
from core.tests.services.test_capture_live_transcription import poll, request, running
from core.tests.services.test_capture_transcription import (
    control,
    enabled,
    final,
    finish,
)
from core.tests.services.test_meeting_captures import command
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_meeting_summary_versions import output
from core.tests.services.test_staged_summaries import complete

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def staged(settings, enabled):
    settings.MEETING_CAPTURE_LIVE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    settings.MEETING_CAPTURE_STAGED_SUMMARY_ENABLED = True
    settings.MEETING_STAGED_SUMMARY_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = True
    settings.MEETING_SUMMARY_AUTOMATION_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "isolated-summary-only"
    with patch("meet.celery_app.app.send_task"):
        yield


def live_text():
    """Real audio offer and final-text ingest, without a provider connection."""
    user, body, capture, worker, asr = running()
    assert upload(user, body, capture).status_code == 200
    feed = poll(asr, worker).data["feed"]
    assert (
        control(
            asr["id"],
            worker,
            "ack_input",
            index=1,
            checksum=feed["entries"][0]["chunk"]["checksum"],
        ).status_code
        == 200
    )
    assert (
        final(asr["id"], worker, text="Confirmed source text. " * 20)[0].status_code
        == 201
    )
    return user, body, capture, worker, asr


def publish(user, body, capture, worker, asr):
    """Stop, seal and publish the same transcription generation."""
    assert command(user, body, capture, "stop").status_code == 200
    assert seal(user, body, capture).status_code == 200
    assert command(user, body, capture, "finalize").status_code == 200
    assert poll(asr, worker, 1).data["feed"]["closed"]
    assert finish(asr["id"], worker).data["status"] == "succeeded"


def test_realtime_keeps_unpublished_originals_and_exact_snapshot_references():
    user, _, capture, _, asr = live_text()
    assert summary_readiness(capture.record)["ready_stages"] == ["realtime"]
    job = prepare_summary_job(capture.record_id, stage="realtime")
    assert job.configuration["capture_transcription_id"] == asr["id"]
    assert job.input_snapshot.delivery["status"] == "open"
    assert job.input_snapshot.segments[0]["segment_revision"] == 1
    assert source_is_current(job)
    version = models.MeetingSummaryVersion.objects.get(pk=complete(job))
    assert version.stage == "realtime"
    assert not capture_transcription.current_originals(capture.record).exists()
    response = client_for(user).get(
        f"/api/v1.0/meeting-records/{capture.record_id}/summary-versions/"
    )
    assert response.data["results"][0]["asr_status"] == "in_progress"
    assert not models.MeetingSession.objects.exists()


def test_append_during_generation_preserves_draft_but_never_mutates_snapshot():
    _, _, capture, worker, asr = live_text()
    job = prepare_summary_job(capture.record_id, stage="realtime")

    def reply(**kwargs):
        assert (
            final(asr["id"], worker, sequence=2, text="Later decision. " * 30)[
                0
            ].status_code
            == 201
        )
        return output(job)

    assert complete(job, reply)
    assert len(job.input_snapshot.segments) == 1
    assert not summary_readiness(capture.record)["ready_stages"]
    models.MeetingProcessingJob.objects.filter(pk=job.pk).update(
        created_at=timezone.now() - timedelta(seconds=61)
    )
    assert summary_readiness(capture.record)["ready_stages"] == ["realtime"]


def test_quick_at_stop_waits_for_asr_tail_before_final():
    user, body, capture, worker, asr = live_text()
    for stage in ["quick", "final"]:
        with pytest.raises(RecordConflict):
            prepare_summary_job(capture.record_id, stage=stage)
    assert command(user, body, capture, "stop").status_code == 200
    assert summary_readiness(capture.record)["ready_stages"] == ["quick"]
    quick = prepare_summary_job(capture.record_id, stage="quick")
    assert seal(user, body, capture).status_code == 200
    assert command(user, body, capture, "finalize").status_code == 200
    with pytest.raises(RecordConflict):
        prepare_summary_job(capture.record_id)
    assert poll(asr, worker, 1).data["feed"]["closed"]
    assert finish(asr["id"], worker).data["status"] == "succeeded"
    quick.refresh_from_db()
    assert quick.status == "queued" and source_is_current(quick)
    assert complete(quick)
    final_job = prepare_summary_job(capture.record_id)
    assert final_job.input_snapshot.delivery["status"] == "complete"
    assert complete(final_job)
    capture.record.refresh_from_db()
    assert summary_readiness(capture.record)["ready_stages"] == ["final"]


@pytest.mark.parametrize(
    "change", ["edit", "delete", "expire", "cancel", "rollout", "owner"]
)
def test_changed_source_or_lost_authority_fences_draft_publication(change, settings):
    _, _, capture, _, asr = live_text()
    job = prepare_summary_job(capture.record_id, stage="realtime")

    def reply(**kwargs):
        originals = models.MeetingOriginalSegment.objects.filter(
            transcription_job_id=asr["id"]
        )
        if change == "edit":
            originals.update(text="Tampered source")
        elif change == "delete":
            originals.delete()
        elif change == "expire":
            models.CaptureTranscriptionJob.objects.filter(pk=asr["id"]).update(
                lease_until=timezone.now() - timedelta(seconds=1)
            )
        elif change == "cancel":
            models.CaptureTranscriptionJob.objects.filter(pk=asr["id"]).update(
                status="canceled"
            )
        elif change == "owner":
            models.MeetingRecord.objects.filter(pk=capture.record_id).update(
                owner=UserFactory()
            )
        else:
            settings.MEETING_CAPTURE_STAGED_SUMMARY_ENABLED = False
        return output(job)

    assert complete(job, reply) is None
    assert not models.MeetingSummaryVersion.objects.exists()


def test_explicit_new_asr_generation_cannot_reuse_old_draft():
    user, _, capture, _, asr = live_text()
    job = prepare_summary_job(capture.record_id, stage="realtime")
    models.CaptureTranscriptionJob.objects.filter(pk=asr["id"]).update(
        status="canceled"
    )
    assert request(user, capture, expected=asr["id"]).status_code == 201
    assert not source_is_current(job)
    assert not summary_readiness(capture.record)["ready_stages"]


def test_automation_requires_opt_in_and_runs_realtime_quick_final_once():
    user, body, capture, worker, asr = live_text()
    assert not models.MeetingSummaryAutomation.objects.exists()
    _, automation, _ = control_automation(
        capture.record_id, user, uuid.uuid4(), {"enabled": True, "expected_revision": 0}
    )
    assert not capture.record.processing_jobs.exists()
    assert tick_automation(automation.pk)
    assert not tick_automation(automation.pk)
    assert complete(capture.record.processing_jobs.get())
    publish(user, body, capture, worker, asr)
    for stage in ["quick", "final"]:
        assert tick_automation(automation.pk)
        job = capture.record.processing_jobs.order_by("-generation").first()
        assert job.configuration["stage"] == stage
        assert complete(job)
    assert not tick_automation(automation.pk)
    automation.refresh_from_db()
    assert automation.state == "completed"
    assert capture.record.summary_versions.count() == 3


def test_automation_failure_does_not_repeat_paid_attempt_and_stop_keeps_audio():
    user, _, capture, _, _ = live_text()
    _, automation, _ = control_automation(
        capture.record_id, user, uuid.uuid4(), {"enabled": True, "expected_revision": 0}
    )
    assert tick_automation(automation.pk)
    job = capture.record.processing_jobs.get()
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = RuntimeError("isolated failure")
        assert complete(job, client.return_value.chat) is None
    assert not tick_automation(automation.pk)
    automation.refresh_from_db()
    assert (
        automation.state == "needs_attention"
        and capture.record.processing_jobs.count() == 1
    )
    control_automation(
        capture.record_id,
        user,
        uuid.uuid4(),
        {"enabled": False, "expected_revision": 1},
    )
    capture.refresh_from_db()
    assert capture.status == "recording"
    assert capture.transcription_jobs.get().status == "running"


def test_public_automation_owner_only_and_rollout_can_be_stopped(settings):
    user, _, capture, _, _ = live_text()
    assert capture_transcription.state(capture.pk, user)["staged_summary_available"]
    path = f"/api/v1.0/meeting-records/{capture.record_id}/summary-automation/"
    assert client_for(user).get(path).data["available"] is True
    other = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=capture.record, user=other, read_summary=True, read_transcript=True
    )
    assert client_for(other).get(path).data["can_control"] is False
    response = client_for(other).post(
        path,
        {"enabled": True, "expected_revision": 0},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 403
    _, automation, _ = control_automation(
        capture.record_id, user, uuid.uuid4(), {"enabled": True, "expected_revision": 0}
    )
    settings.MEETING_CAPTURE_STAGED_SUMMARY_ENABLED = False
    assert not capture_transcription.state(capture.pk, user)["staged_summary_available"]
    assert not tick_automation(automation.pk)
    automation.refresh_from_db()
    assert not automation.enabled and automation.error_code == "rollout_disabled"
    assert not client_for(user).get(path).data["available"]


def test_short_confirmed_text_waits_for_more_content():
    _, body, capture, worker, asr = running()
    user = capture.created_by
    upload(user, body, capture)
    poll(asr, worker)
    final(asr["id"], worker)
    assert not summary_readiness(capture.record)["ready_stages"]
