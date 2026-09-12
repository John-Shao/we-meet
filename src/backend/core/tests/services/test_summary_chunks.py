"""Long-source coverage, reusable extraction, reference rebinding and cost fences."""

import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.core.exceptions import ValidationError

import pytest

from core import models
from core.services.llm_client import LLMClient
from core.services.meeting_records import RecordConflict, retry_job
from core.services.meeting_summary_chunks import CHUNK_BYTES, encode, partition
from core.services.meeting_summary_versions import (
    execute_summary_job,
    prepare_summary_job,
    summary_readiness,
)
from core.tests.services.test_meeting_records import online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VERSIONED_SUMMARY_ENABLED = True
    settings.MEETING_SUMMARY_CHUNKING_ENABLED = True
    settings.DASHSCOPE_API_KEY = "isolated-test-only"


def long_note():
    user, session, first, record = online_note(text="Opening decision")
    models.Transcript.objects.bulk_create(
        [
            models.Transcript(
                room=session.room,
                session=session,
                speaker_identity="1",
                speaker_name="Speaker",
                text=f"Part {index:02d}: " + "x" * 10000,
                started_at=session.started_at + timedelta(seconds=index + 1),
            )
            for index in range(30)
        ]
    )
    return user, first, record


def model_reply(**kwargs):
    """Expose all source references so tests can inspect the actual synthesis input."""
    data = json.loads(kwargs["user"])
    if "segment_id" in data[0]:
        points = [
            {
                "text": row["text"][:30],
                "source_refs": [
                    {
                        key: row[key]
                        for key in (
                            "segment_id",
                            "segment_revision",
                            "start_ms",
                            "end_ms",
                        )
                    }
                ],
            }
            for row in data
        ]
    else:
        points = [point for chunk in data for point in chunk["decisions"]]
    return encode(
        {
            "overview": "All supplied parts reconciled",
            "decisions": points,
            "chapters": [],
            "action_items": [],
            "open_questions": [],
        }
    )


def test_every_source_row_reaches_extraction_and_all_parts_reach_synthesis():
    _, first, record = long_note()
    job = prepare_summary_job(record.pk)
    chunks = partition(job.input_snapshot.segments)
    assert len(chunks) > 1
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = model_reply
        version_id = execute_summary_job(job.pk, 1)
        calls = client.return_value.chat.call_args_list
        assert len(calls) == len(chunks) + 1
        assert client.call_args.kwargs["max_retries"] == 0
        extracted = [
            row for call in calls[:-1] for row in json.loads(call.kwargs["user"])
        ]
        assert extracted == job.input_snapshot.segments
        assert str(first.pk) == extracted[0]["segment_id"]
        assert all(
            len(call.kwargs["user"].encode()) <= CHUNK_BYTES for call in calls[:-1]
        )
        assert all(call.kwargs["require_complete"] for call in calls)
    version = models.MeetingSummaryVersion.objects.get(pk=version_id)
    assert len(version.content["decisions"]) == len(job.input_snapshot.segments)
    assert record.summary_chunks.count() == len(chunks)
    cached = record.summary_chunks.first()
    with pytest.raises(ValidationError):
        cached.save()


def test_retry_reuses_successful_extractions_after_later_chunk_failure():
    _, _, record = long_note()
    job = prepare_summary_job(record.pk)
    calls = 0

    def fail_second(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("redacted provider failure")
        return model_reply(**kwargs)

    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = fail_second
        assert execute_summary_job(job.pk, 1) is None
    assert record.summary_chunks.count() == 1
    assert not record.summary_versions.exists()
    retry_job(job.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = model_reply
        assert execute_summary_job(job.pk, 2)
        assert client.return_value.chat.call_count == len(
            partition(job.input_snapshot.segments)
        )


def test_regeneration_reuses_maps_and_source_edit_rebinds_unchanged_chunk_references():
    _, first, record = long_note()
    job = prepare_summary_job(record.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = model_reply
        assert execute_summary_job(job.pk, 1)
        again = prepare_summary_job(record.pk, regenerate=True)
        client.return_value.chat.reset_mock()
        assert execute_summary_job(again.pk, 1)
        assert client.return_value.chat.call_count == 1
        models.Transcript.objects.filter(pk=first.pk).update(text="Changed decision")
        updated = prepare_summary_job(record.pk)
        client.return_value.chat.reset_mock()
        result_id = execute_summary_job(updated.pk, 1)
        assert (
            client.return_value.chat.call_count == 2
        )  # Changed first chunk + synthesis.
    version = models.MeetingSummaryVersion.objects.get(pk=result_id)
    assert updated.input_revision != job.input_revision
    assert all(
        ref["segment_revision"] == updated.input_revision
        for point in version.content["decisions"]
        for ref in point["source_refs"]
    )


def test_model_config_and_record_identity_do_not_share_cached_extractions(settings):
    _, _, record = long_note()
    first = prepare_summary_job(record.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = model_reply
        assert execute_summary_job(first.pk, 1)
        settings.MEETING_SUMMARY_MODEL = "changed-model"
        second = prepare_summary_job(record.pk, regenerate=True)
        client.return_value.chat.reset_mock()
        assert execute_summary_job(second.pk, 1)
        assert (
            client.return_value.chat.call_count
            == len(partition(second.input_snapshot.segments)) + 1
        )
        _, _, other = long_note()
        third = prepare_summary_job(other.pk)
        client.return_value.chat.reset_mock()
        assert execute_summary_job(third.pk, 1)
        assert client.return_value.chat.call_count > 1


def test_source_change_during_extraction_cancels_before_cache_or_next_paid_call():
    _, first, record = long_note()
    job = prepare_summary_job(record.pk)

    def changed(**kwargs):
        models.Transcript.objects.filter(pk=first.pk).update(
            text="Corrected during call"
        )
        return model_reply(**kwargs)

    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = changed
        assert execute_summary_job(job.pk, 1) is None
        assert client.return_value.chat.call_count == 1
    assert not record.summary_chunks.exists() and not record.summary_versions.exists()
    job.refresh_from_db()
    assert job.status == "canceled"


def test_oversized_single_row_and_total_budget_fail_without_truncation():
    _, _, row, record = online_note(text="x" * 300000)
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk)
    assert not record.processing_jobs.exists()
    assert summary_readiness(record)["blocked_reason"] == "source_budget_exceeded"
    models.Transcript.objects.filter(pk=row.pk).update(text="x" * 1500001)
    with pytest.raises(RecordConflict):
        prepare_summary_job(record.pk)


def test_corrupt_cache_reference_is_rejected_before_synthesis():
    _, _, record = long_note()
    job = prepare_summary_job(record.pk)
    with patch("core.services.meeting_summary_versions.LLMClient") as client:
        client.return_value.chat.side_effect = model_reply
        assert execute_summary_job(job.pk, 1)
        cached = record.summary_chunks.first()
        body = cached.content
        body["decisions"][0]["source_refs"][0]["segment_id"] = "foreign"
        models.MeetingSummaryChunk.objects.filter(pk=cached.pk).update(content=body)
        again = prepare_summary_job(record.pk, regenerate=True)
        client.return_value.chat.reset_mock()
        assert execute_summary_job(again.pk, 1) is None
        client.return_value.chat.assert_not_called()


@pytest.mark.parametrize("reason", ["length", "content_filter", None])
def test_complete_output_guard_rejects_even_valid_json_when_finish_is_not_stop(reason):
    client = LLMClient.__new__(LLMClient)
    client._client = MagicMock()  # pylint: disable=protected-access
    client._model = "model"  # pylint: disable=protected-access
    client._client.chat.completions.create.return_value = SimpleNamespace(  # pylint: disable=protected-access
        choices=[
            SimpleNamespace(
                finish_reason=reason,
                message=SimpleNamespace(content='{"valid":"json"}'),
            )
        ]
    )
    with pytest.raises(ValueError):
        client.chat(system="schema", user="source", require_complete=True)
    assert client.chat(system="schema", user="source") == '{"valid":"json"}'
