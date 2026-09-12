"""Draft source watermarks, stage gates and concurrent append/correction fences."""

from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone

import pytest

from core import models
from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
    summary_readiness,
)
from core.services.transcript_delivery import _bump
from core.tests.services.test_meeting_records import client_for, online_note
from core.tests.services.test_meeting_summary_requests import payload, post
from core.tests.services.test_meeting_summary_versions import output

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = True
    settings.MEETING_STAGED_SUMMARY_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "isolated-test-only"


def live_note():
    """Enough stable text for the first coalesced realtime update."""
    user, session, row, record = online_note(text="Meeting source. " * 30)
    models.MeetingSession.objects.filter(pk=session.pk).update(
        status="active", ended_at=None, end_reason=""
    )
    record.refresh_from_db()
    return user, session, row, record


def append_text(session, record):
    """Simulate a newly committed FINAL and the actual tracked-ingest revision fence."""
    row = models.Transcript.objects.create(
        room=session.room,
        session=session,
        speaker_name="Speaker 2",
        speaker_identity="2",
        text="Additional decisions. " * 30,
        started_at=session.started_at + timedelta(minutes=5),
    )
    _bump(record)
    return row


def complete(job, effect=None):
    """Only the model is simulated; source snapshots and writes use the real DB."""
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        if effect:
            client.return_value.chat.side_effect = effect
        return execute_summary_job(job.pk, job.attempt)


def test_realtime_keeps_snapshot_during_appends_and_does_not_claim_latest_source():
    user, session, _, record = live_note()
    job = prepare_summary_job(record.pk, stage="realtime")

    def reply(**kwargs):
        assert kwargs["max_tokens"] == 4096
        append_text(session, record)
        return output(job)

    version = models.MeetingSummaryVersion.objects.get(pk=complete(job, reply))
    assert version.stage == "realtime"
    assert len(version.input_snapshot.segments) == 1
    assert record.transcript_versions.count() == 1
    job.refresh_from_db()
    assert job.status == "partial"
    result = (
        client_for(user)
        .get(f"/api/v1.0/meeting-records/{record.pk}/summary-versions/")
        .json()["results"][0]
    )
    assert result["is_current"] is False
    assert result["source_segment_count"] == 1
    assert result["source_through_ms"] == 0
    assert result["coverage_status"] == "unverified"


@pytest.mark.parametrize("change", ["edit", "delete", "move", "disabled"])
def test_draft_corrections_source_changes_and_rollout_disable_fence_publication(
    change, settings
):
    _, _, row, record = live_note()
    job = prepare_summary_job(record.pk, stage="realtime")

    def reply(**kwargs):
        if change == "edit":
            models.Transcript.objects.filter(pk=row.pk).update(text="Corrected")
        elif change == "delete":
            row.delete()
        elif change == "move":
            models.Transcript.objects.filter(pk=row.pk).update(session=None)
        else:
            settings.MEETING_STAGED_SUMMARY_ENABLED = False
        return output(job)

    assert complete(job, reply) is None
    assert not models.MeetingSummaryVersion.objects.exists()
    job.refresh_from_db()
    assert job.status == "canceled"


def test_stable_text_and_time_thresholds_are_enforced_on_mutations():
    _, session, row, record = live_note()
    models.Transcript.objects.filter(pk=row.pk).update(text="too short")
    assert summary_readiness(record)["ready_stages"] == []
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk, stage="realtime")
    models.Transcript.objects.filter(pk=row.pk).update(text="Enough text " * 30)
    first = prepare_summary_job(record.pk, stage="realtime")
    assert prepare_summary_job(record.pk, stage="realtime").pk == first.pk
    assert complete(first)
    append_text(session, record)
    assert summary_readiness(record)["next_update_at"] is not None
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk, stage="realtime")
    models.MeetingProcessingJob.objects.filter(pk=first.pk).update(
        created_at=timezone.now() - timedelta(seconds=61)
    )
    assert summary_readiness(record)["ready_stages"] == ["realtime"]
    second = prepare_summary_job(record.pk, stage="realtime")
    assert second.generation == 2
    assert len(second.input_snapshot.segments) == 2
    assert first.input_snapshot.segments[0]["text"] == "Enough text " * 30


def test_quick_allows_open_tail_final_waits_and_never_downgrades():
    _, session, _, record = online_note()
    delivery = models.TranscriptDelivery.objects.create(session=session)
    assert summary_readiness(record)["ready_stages"] == ["quick"]
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk)
    quick = prepare_summary_job(record.pk, stage="quick")

    def reply(**kwargs):
        append_text(session, record)
        return output(quick)

    assert complete(quick, reply)
    delivery.state = "incomplete"
    delivery.final_sequence = 0
    delivery.save()
    _bump(record)
    assert summary_readiness(record)["ready_stages"] == ["quick", "final"]
    final = prepare_summary_job(record.pk)
    assert len(final.input_snapshot.segments) == 2
    version = models.MeetingSummaryVersion.objects.get(pk=complete(final))
    assert version.stage == "final"
    assert version.job.result["delivery_status"] != "complete"
    assert summary_readiness(record)["ready_stages"] == ["final"]
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk, stage="quick")


def test_active_final_and_quick_rejected_disabled_rollout_preserves_legacy(settings):
    _, session, _, record = live_note()
    for stage in ["quick", "final"]:
        with pytest.raises(RecordConflict):
            prepare_summary_job(record.pk, stage=stage)
    settings.MEETING_STAGED_SUMMARY_ENABLED = False
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk, stage="realtime")
    models.MeetingSession.objects.filter(pk=session.pk).update(
        status="ended", ended_at=timezone.now(), end_reason="room_finished"
    )
    record.refresh_from_db()
    models.TranscriptDelivery.objects.create(session=session)
    assert prepare_summary_job(record.pk).configuration["stage"] == "final"


def test_public_stage_intents_retry_and_inflight_guards():
    user, session, _, record = live_note()
    response = post(user, record, {**payload(record), "stage": "realtime"})
    assert response.status_code == 202
    job = record.processing_jobs.get()
    append_text(session, record)
    response = post(user, record, {**payload(record, job), "stage": "realtime"})
    assert response.status_code == 409
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = RuntimeError("redacted")
        assert execute_summary_job(job.pk, 1) is None
    job.refresh_from_db()
    assert job.status == "failed"
    assert post(user, record, payload(record, job, "retry")).status_code == 409
    response = post(
        user, record, {**payload(record, job, "retry"), "stage": "realtime"}
    )
    assert response.status_code == 202
    job.refresh_from_db()
    assert job.attempt == 2
    assert complete(job)
    response = (
        client_for(user)
        .get(f"/api/v1.0/meeting-records/{record.pk}/summary-job/")
        .json()
    )
    assert response["staged_summaries_enabled"] is True
    assert response["job"]["stage"] == "realtime"


def test_final_still_cancels_on_append():
    _, session, _, record = online_note()
    final = prepare_summary_job(record.pk)
    append_text(session, record)
    assert complete(final) is None
    final.refresh_from_db()
    assert final.status == "canceled"
