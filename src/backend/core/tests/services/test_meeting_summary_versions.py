"""Versioned summary workers: real database state, mocked provider transport."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services.meeting_records import RecordConflict, retry_job, transition_job
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
    recover_summary_job,
)
from core.tests.services.test_meeting_records import client_for, online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-provider-key"


def output(job):
    segment = job.input_snapshot.segments[0]
    return json.dumps(
        {
            "overview": "Meeting overview",
            "decisions": [
                {
                    "text": "Decision",
                    "source_refs": [
                        {
                            key: segment[key]
                            for key in (
                                "segment_id",
                                "segment_revision",
                                "start_ms",
                                "end_ms",
                            )
                        }
                    ],
                }
            ],
            "chapters": [],
            "action_items": [],
            "open_questions": [],
        }
    )


def test_snapshots_are_idempotent_and_keep_previous_text():
    _, _, transcript, record = online_note()
    first = prepare_summary_job(record.pk)
    assert prepare_summary_job(record.pk).pk == first.pk
    transcript.text = "Corrected original"
    transcript.save()
    second = prepare_summary_job(record.pk)
    assert second.input_revision == first.input_revision + 1
    assert (
        first.input_snapshot.segments[0]["text"]
        != second.input_snapshot.segments[0]["text"]
    )
    assert models.MeetingTranscriptVersion.objects.count() == 2
    snapshot = first.input_snapshot
    with pytest.raises(ValidationError):
        snapshot.save()


def test_worker_persists_once_and_does_not_change_manual_summary(settings):
    user, session, _, record = online_note()
    legacy = models.Summary.objects.create(
        room=session.room,
        session=session,
        content="AI old",
        edited_content="Human review",
    )
    job = prepare_summary_job(record.pk)
    settings.MEETING_SUMMARY_MODEL = "changed-after-enqueue"
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        version_id = execute_summary_job(job.pk, 1)
        assert execute_summary_job(job.pk, 1) is None
        assert client.call_count == 1
        assert client.call_args.kwargs["model"] == "qwen3.8-flash"
    version = models.MeetingSummaryVersion.objects.get(pk=version_id)
    job.refresh_from_db()
    assert job.status == "partial" and job.result == {"coverage_status": "unverified"}
    legacy.refresh_from_db()
    assert legacy.effective_content == "Human review"
    assert models.MeetingSummaryVersion.objects.count() == 1
    with pytest.raises(ValidationError):
        version.save()
    response = client_for(user).get(
        f"/api/v1.0/meeting-records/{record.pk}/summary-versions/"
    )
    assert response.json()["results"][0]["is_current"] is True
    assert "segments" not in response.json()["results"][0]


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        '{"overview":"incomplete"}',
        '{"overview":"x","decisions":[],"chapters":[],"action_items":[],"open_questions":[],"task_id":"invented"}',
    ],
)
def test_invalid_output_never_publishes(raw):
    _, _, _, record = online_note()
    job = prepare_summary_job(record.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = raw
        assert execute_summary_job(job.pk, 1) is None
    job.refresh_from_db()
    assert job.status == "failed" and job.error_code == "invalid_output"
    assert not models.MeetingSummaryVersion.objects.exists()


def test_foreign_citation_is_rejected():
    _, _, _, record = online_note()
    job = prepare_summary_job(record.pk)
    raw = json.loads(output(job))
    raw["decisions"][0]["source_refs"][0]["segment_id"] = "another-record"
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = json.dumps(raw)
        execute_summary_job(job.pk, 1)
    job.refresh_from_db()
    assert job.error_code == "invalid_output"
    assert not models.MeetingSummaryVersion.objects.exists()


def test_provider_failure_is_sanitized_and_retry_uses_new_attempt():
    _, _, _, record = online_note()
    job = prepare_summary_job(record.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = RuntimeError("secret request payload")
        execute_summary_job(job.pk, 1)
    job.refresh_from_db()
    assert job.error_code == "provider_unavailable" and job.result == {}
    retry_job(job.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        assert execute_summary_job(job.pk, 1) is None
        assert execute_summary_job(job.pk, 2)
        assert client.call_count == 1


@pytest.mark.parametrize("change", ["edit", "regenerate", "delete"])
def test_changed_source_or_superseding_job_during_call_does_not_publish(change):
    _, _, transcript, record = online_note()
    job = prepare_summary_job(record.pk)

    def reply(**kwargs):
        if change == "edit":
            models.Transcript.objects.filter(pk=transcript.pk).update(
                text="late correction"
            )
        elif change == "delete":
            transcript.delete()
        else:
            prepare_summary_job(record.pk, regenerate=True)
        return output(job)

    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = reply
        assert execute_summary_job(job.pk, 1) is None
    assert not models.MeetingSummaryVersion.objects.exists()


def test_oversized_input_is_rejected_without_silent_truncation():
    _, _, transcript, record = online_note()
    models.Transcript.objects.filter(pk=transcript.pk).update(text="长" * 90_000)
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk)
    assert not models.MeetingProcessingJob.objects.exists()


def test_disabled_worker_makes_no_call(settings):
    _, _, _, record = online_note()
    job = prepare_summary_job(record.pk)
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = False
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        assert execute_summary_job(job.pk, 1) is None
        client.assert_not_called()
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk)


def test_explicit_recovery_fences_old_worker():
    _, _, _, record = online_note()
    job = prepare_summary_job(record.pk)
    transition_job(job.pk, attempt=1, target="running")
    with pytest.raises(RecordConflict):
        recover_summary_job(job.pk)
    models.MeetingProcessingJob.objects.filter(pk=job.pk).update(
        updated_at=timezone.now() - timedelta(minutes=11)
    )
    recover_summary_job(job.pk)
    retry_job(job.pk)
    assert execute_summary_job(job.pk, 1) is None


def test_historical_text_remains_readable_and_is_not_shared_with_summary_only_reader():
    owner, _, transcript, record = online_note()
    job = prepare_summary_job(record.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.return_value = output(job)
        execute_summary_job(job.pk, 1)
    models.Transcript.objects.filter(pk=transcript.pk).update(text="Later correction")
    url = f"/api/v1.0/meeting-records/{record.pk}/"
    snapshot_url = url + f"transcript-versions/{job.input_snapshot_id}/"
    response = client_for(owner).get(snapshot_url)
    assert response.status_code == 200
    assert response.json()["segments"][0]["text"] == "first meeting"
    assert (
        client_for(owner)
        .get(url + "summary-versions/")
        .json()["results"][0]["is_current"]
        is False
    )
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    assert client_for(reader).get(url + "summary-versions/").status_code == 200
    assert client_for(reader).get(snapshot_url).status_code == 403
    _, _, _, other = online_note(user=owner)
    other_url = f"/api/v1.0/meeting-records/{other.pk}/transcript-versions/{job.input_snapshot_id}/"
    assert client_for(owner).get(other_url).status_code == 404


def test_command_dispatches_attempt_and_reports_inline_failures():
    _, _, _, record = online_note()
    with patch(
        "core.management.commands.generate_record_summary.generate_record_summary.apply_async"
    ) as dispatch:
        call_command("generate_record_summary", str(record.pk))
        job = record.processing_jobs.get()
        dispatch.assert_called_once_with(args=[str(job.pk), 1])
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = RuntimeError("secret payload")
        with pytest.raises(CommandError, match="provider_unavailable"):
            call_command("generate_record_summary", str(record.pk))


@pytest.mark.django_db(transaction=True)
def test_concurrent_deliveries_call_provider_once():
    _, _, _, record = online_note()
    job = prepare_summary_job(record.pk)
    entered, release = Event(), Event()

    def reply(**kwargs):
        entered.set()
        assert release.wait(10)
        return output(job)

    def run():
        close_old_connections()
        try:
            return execute_summary_job(job.pk, 1)
        finally:
            close_old_connections()

    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = reply
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(run)
            try:
                assert entered.wait(5)
                second = pool.submit(run)
                assert second.result(timeout=5) is None
            finally:
                release.set()
            assert first.result(timeout=5)
        assert client.call_count == 1
