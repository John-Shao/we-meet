"""Independent overview generation and its original-source/security boundaries."""

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest

from core import models
from core.factories import UserFactory
from core.services import meeting_overviews as overview
from core.services.meeting_summary_requests import (
    dispatch_pending_overviews,
    dispatch_summary_request,
)
from core.services.meeting_summary_versions import prepare_summary_job
from core.tests.services.test_meeting_records import client_for, online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_OVERVIEW_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = True
    settings.CELERY_ENABLED = True
    settings.DASHSCOPE_API_KEY = "test-only"


def request(user, record, job=None, operation="generate", key=None):
    record.refresh_from_db()
    return client_for(user).post(
        f"/api/v1.0/meeting-records/{record.pk}/overview-requests/",
        {
            "operation": operation,
            "expected_revision": record.revision,
            "expected_job_id": str(job.pk) if job else None,
            "expected_attempt": job.attempt if job else None,
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def output(job):
    ref = {
        key: job.input_snapshot.segments[0][key]
        for key in ("segment_id", "segment_revision", "start_ms", "end_ms")
    }
    return json.dumps(
        {
            "synopsis": "Independent recording digest",
            "topics": [
                {
                    "title": "Main idea",
                    "text": "Original-source point",
                    "source_refs": [ref],
                }
            ],
        }
    )


def set_language(user, record, language, previous="auto"):
    return client_for(user).patch(
        f"/api/v1.0/meeting-records/{record.pk}/overview/",
        {"output_language": language, "expected_output_language": previous},
        format="json",
    )


def test_language_preference_is_shared_without_generating_or_changing_source():
    user, _, _, record = online_note()
    revision = record.revision
    assert set_language(user, record, "zh").status_code == 200
    record.refresh_from_db()
    assert record.overview_language == "zh"
    assert record.revision == revision
    assert not record.processing_jobs.exists()
    state = (
        client_for(user).get(f"/api/v1.0/meeting-records/{record.pk}/overview/").json()
    )
    assert state["output_language"] == "zh"
    assert set_language(user, record, "en").status_code == 409
    assert set_language(user, record, "arbitrary instructions", "zh").status_code == 400


def test_read_only_collaborator_cannot_change_language():
    _, _, _, record = online_note()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_transcript=True
    )
    assert set_language(reader, record, "en").status_code == 403
    record.refresh_from_db()
    assert record.overview_language == "auto"


def test_selected_language_is_frozen_and_changed_language_starts_new_job():
    user, _, _, record = online_note(text="中文课堂讲解")
    assert set_language(user, record, "zh").status_code == 200
    key = uuid.uuid4()
    assert request(user, record, key=key).status_code == 202
    job = record.processing_jobs.get(kind="overview")
    assert job.configuration["output_language"] == "zh"
    assert set_language(user, record, "en", "zh").status_code == 200
    # The same intent replays its frozen language, even after the preference changes.
    assert request(user, record, key=key).json()["replayed"] is True
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = output(job)
        assert overview.execute(job.pk, job.attempt)
        assert "in Chinese" in llm.return_value.chat.call_args.kwargs["system"]
    record.processing_jobs.filter(pk=job.pk).update(status="failed", retryable=True)
    job.refresh_from_db()
    assert request(user, record, job, operation="retry").status_code == 202
    latest = record.processing_jobs.filter(kind="overview").latest("generation")
    assert latest.pk != job.pk
    assert latest.configuration["output_language"] == "en"
    assert record.overview_versions.count() == 1
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = output(latest)
        assert overview.execute(latest.pk, latest.attempt)
        assert "in English" in llm.return_value.chat.call_args.kwargs["system"]


def test_overview_without_language_metadata_still_requires_source_language():
    user, _, row, record = online_note(text="同类项的字母和指数必须相同。")
    row.language = ""
    row.save()
    assert request(user, record).status_code == 202
    job = record.processing_jobs.get(kind="overview")
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = output(job)
        assert overview.execute(job.pk, job.attempt)
        assert (
            "primary language of the original transcript"
            in llm.return_value.chat.call_args.kwargs["system"]
        )


def test_independent_job_prompt_storage_and_no_minutes_delivery():
    user, _, _, record = online_note(text="Original discussion about management")
    summary_job = prepare_summary_job(record.pk)
    models.MeetingSummaryVersion.objects.create(
        record=record,
        job=summary_job,
        input_snapshot=summary_job.input_snapshot,
        content={"overview": "DO NOT REUSE THIS MINUTES TEXT"},
        model_used="old",
    )
    assert request(user, record).status_code == 202
    job = record.processing_jobs.get(kind="overview")
    assert job.pk != summary_job.pk
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = output(job)
        assert overview.execute(job.pk, job.attempt)
        assert overview.execute(job.pk, job.attempt) is None
        kwargs = llm.return_value.chat.call_args.kwargs
        assert "Original discussion about management" in kwargs["user"]
        assert "DO NOT REUSE" not in kwargs["user"]
        assert "not structured meeting minutes" in kwargs["system"]
        assert llm.return_value.chat.call_count == 1
    assert models.MeetingOverviewVersion.objects.count() == 1
    assert models.MeetingSummaryVersion.objects.count() == 1
    summary_job.refresh_from_db()
    assert summary_job.status == "queued"
    response = client_for(user).get(f"/api/v1.0/meeting-records/{record.pk}/overview/")
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    assert (
        response.json()["version"]["content"]["synopsis"]
        == "Independent recording digest"
    )
    assert response.json()["version"]["is_current"] is True


def test_no_fallback_to_existing_minutes():
    user, _, _, record = online_note()
    job = prepare_summary_job(record.pk)
    models.MeetingSummaryVersion.objects.create(
        record=record,
        job=job,
        input_snapshot=job.input_snapshot,
        content={"overview": "Existing minutes"},
        model_used="old",
    )
    data = (
        client_for(user).get(f"/api/v1.0/meeting-records/{record.pk}/overview/").json()
    )
    assert data["version"] is None and data["job"] is None


def test_overview_works_with_minutes_generation_disabled(settings):
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = False
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = False
    user, _, _, record = online_note()
    assert request(user, record).status_code == 202
    job = record.processing_jobs.get(kind="overview")
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = output(job)
        assert overview.execute(job.pk, 1)


def test_idempotent_request_and_distinct_worker_dispatch(
    django_capture_on_commit_callbacks,
):
    user, _, _, record = online_note()
    key = uuid.uuid4()
    with (
        patch("meet.celery_app.app.send_task") as broker,
        django_capture_on_commit_callbacks(execute=True),
    ):
        first = request(user, record, key=key)
        second = request(user, record, key=key)
    assert first.status_code == second.status_code == 202
    assert first.json()["request_id"] == second.json()["request_id"]
    assert second.json()["replayed"]
    broker.assert_called_once()
    assert (
        broker.call_args.args[0]
        == "core.tasks.summary_versions.generate_record_overview"
    )


@pytest.mark.parametrize("role", ["shared", "outsider"])
def test_readers_cannot_generate(role):
    _, _, _, record = online_note()
    user = UserFactory()
    if role == "shared":
        models.MeetingRecordAccess.objects.create(
            record=record, user=user, read_summary=True
        )
    assert request(user, record).status_code == (403 if role == "shared" else 404)
    assert not models.MeetingProcessingJob.objects.exists()


@pytest.mark.parametrize("change", ["source", "permission"])
def test_change_during_provider_call_prevents_publication(change):
    user, session, row, record = online_note()
    assert request(user, record).status_code == 202
    job = record.processing_jobs.get(kind="overview")

    def respond(**_):
        if change == "source":
            row.text = "Corrected text"
            row.save()
        else:
            models.ResourceAccess.objects.filter(
                resource=session.room, user=user
            ).delete()
        return output(job)

    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.side_effect = respond
        assert overview.execute(job.pk, 1) is None
    assert not models.MeetingOverviewVersion.objects.exists()
    job.refresh_from_db()
    assert job.status == "canceled"


@pytest.mark.parametrize("invalid", ["schema", "citation"])
def test_reject_invalid_output_and_explicit_retry(invalid):
    user, _, _, record = online_note()
    assert request(user, record).status_code == 202
    job = record.processing_jobs.get(kind="overview")
    raw = json.loads(output(job))
    if invalid == "schema":
        raw["decisions"] = []
    else:
        raw["topics"][0]["source_refs"][0]["segment_id"] = "foreign-source"
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = json.dumps(raw)
        assert overview.execute(job.pk, 1) is None
    job.refresh_from_db()
    assert job.status == "failed" and job.retryable
    assert request(user, record, job, "retry").status_code == 202
    job.refresh_from_db()
    assert job.attempt == 2
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = output(job)
        assert overview.execute(job.pk, 1) is None
        assert overview.execute(job.pk, 2)
    assert not models.MeetingSummaryVersion.objects.exists()


def test_broker_failure_leaves_recoverable_overview_intent(
    django_capture_on_commit_callbacks,
):
    user, _, _, record = online_note()
    with (
        patch("meet.celery_app.app.send_task", side_effect=OSError),
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = request(user, record)
    assert response.status_code == 202
    intent = models.MeetingSummaryRequest.objects.get()
    assert intent.dispatch_state == "pending"
    with patch("meet.celery_app.app.send_task") as broker:
        assert dispatch_summary_request(intent.pk)
    assert broker.call_args.args[0].endswith("generate_record_overview")


def test_long_recording_extracts_all_original_chunks_without_minutes_cache():
    user, session, row, record = online_note(text="A" * 40000)
    for index, marker in enumerate(["B", "C"], 1):
        models.Transcript.objects.create(
            room=session.room,
            session=session,
            text=marker * 40000,
            started_at=row.started_at + timedelta(seconds=index),
            speaker_name="Speaker",
            speaker_identity=str(user.pk),
        )
    seen = []

    def respond(**kwargs):
        items = json.loads(kwargs["user"])
        if "segment_id" in items[0]:
            seen.extend(item["text"] for item in items)
            ref = {
                key: items[0][key]
                for key in ("segment_id", "segment_revision", "start_ms", "end_ms")
            }
        else:
            assert len(items) == 3
            ref = items[-1]["topics"][0]["source_refs"][0]
        return json.dumps(
            {
                "synopsis": "Digest",
                "topics": [{"title": "Topic", "text": "Point", "source_refs": [ref]}],
            }
        )

    with (
        patch.object(overview, "DIRECT_BYTES", 100000),
        patch("core.services.meeting_overviews.LLMClient") as llm,
    ):
        assert request(user, record).status_code == 202
        job = record.processing_jobs.get(kind="overview")
        llm.return_value.chat.side_effect = respond
        assert overview.execute(job.pk, 1)
        assert llm.return_value.chat.call_count == 4
    assert seen == ["A" * 40000, "B" * 40000, "C" * 40000]
    assert not models.MeetingSummaryChunk.objects.exists()
    assert not models.MeetingSummaryVersion.objects.exists()


def test_old_overview_survives_failed_regeneration_and_reports_changed_source():
    user, _, row, record = online_note()
    assert request(user, record).status_code == 202
    job = record.processing_jobs.get(kind="overview")
    with patch("core.services.meeting_overviews.LLMClient") as llm:
        llm.return_value.chat.return_value = output(job)
        old_id = overview.execute(job.pk, 1)
    row.text = "Changed original text"
    row.save()
    assert request(user, record, job, "regenerate").status_code == 202
    latest = record.processing_jobs.filter(kind="overview").latest("generation")
    with patch("core.services.meeting_overviews.LLMClient", side_effect=OSError):
        assert overview.execute(latest.pk, 1) is None
    result = (
        client_for(user).get(f"/api/v1.0/meeting-records/{record.pk}/overview/").json()
    )
    assert result["version"]["id"] == old_id
    assert result["version"]["is_current"] is False
    assert result["job"]["status"] == "failed"


def test_periodic_dispatch_is_independent_of_minutes_automation(settings):
    settings.MEETING_SUMMARY_AUTOMATION_ENABLED = False
    settings.MEETING_SUMMARY_REQUESTS_ENABLED = False
    user, _, _, record = online_note()
    assert request(user, record).status_code == 202
    with patch("meet.celery_app.app.send_task") as broker:
        dispatch_pending_overviews()
    broker.assert_called_once()
    assert broker.call_args.args[0].endswith("generate_record_overview")
