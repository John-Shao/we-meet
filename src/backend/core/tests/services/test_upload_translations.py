"""Whole-upload translation: ACL, revision, complete output and paid replay fences."""

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone

import httpx
import pytest
from openai import APIConnectionError, APIStatusError, APITimeoutError

from core import models
from core.factories import UserFactory
from core.services import upload_translations as service
from core.services.llm_client import LLMIncompleteOutput
from core.services.record_lifecycle import busy
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_upload_summary_source import published
from core.tests.services.test_uploaded_recordings import enabled

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def translation_enabled(settings):
    settings.UPLOAD_TRANSCRIPT_TRANSLATION_ENABLED = True


def setup():
    owner, upload = published()
    record = upload.record
    return owner, record, f"/api/v1.0/meeting-records/{record.pk}/upload-translations/"


def prepare(owner, record, **kwargs):
    return service.prepare(
        record.pk,
        owner,
        kwargs.get("key", uuid.uuid4()),
        kwargs.get("target", "zh"),
        record.revision,
    )


def output(**kwargs):
    body = json.loads(kwargs["user"])
    return json.dumps(
        {
            "segments": [
                {"id": row["id"], "text": "Translated <content>"}
                for row in body["segments"]
            ]
        }
    )


def finish(job):
    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = output
        service.execute(job.pk)
        service.execute(job.pk)
        assert llm.call_count == 1
    job.refresh_from_db()
    assert job.status == "succeeded"


def test_api_async_intent_replay_target_conflict_and_complete_export():
    owner, record, path = setup()
    client = client_for(owner)
    body = {
        "key": str(uuid.uuid4()),
        "target": "zh",
        "expected_revision": record.revision,
    }
    with patch.object(service, "LLMClient") as llm:
        response = client.post(path, body, format="json")
        assert response.status_code == 202, response.data
        assert not llm.called
    again = client.post(path, body, format="json")
    assert again.data["id"] == response.data["id"]
    assert client.post(path, {**body, "target": "en"}, format="json").status_code == 409
    job = record.upload_translations.get()
    assert busy(record)
    finish(job)
    assert not busy(record)
    assert prepare(owner, record).pk == job.pk
    detail = client.get(path + str(job.pk) + "/")
    assert detail.data["results"][0]["text"] == "Original words"
    assert detail.data["results"][0]["translated_text"] == "Translated <content>"
    assert detail.data["results"][0]["start_ms"] == 10
    assert detail["Cache-Control"] == "private, no-store"
    for fmt in ("txt", "srt", "vtt"):
        exported = client.get(path + str(job.pk) + "/export/?as=" + fmt)
        assert exported.status_code == 200
        assert exported["Cache-Control"] == "private, no-store"
        assert "Original words" not in exported.content.decode()
    assert "&lt;content&gt;" in exported.content.decode()


def test_original_sharing_only_current_access_no_shared_generation():
    owner, record, path = setup()
    job = prepare(owner, record)
    finish(job)
    reader = UserFactory()
    client = client_for(reader)
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    endpoints = [path, path + str(job.pk) + "/", path + str(job.pk) + "/export/"]
    for endpoint in endpoints:
        assert client.get(endpoint).status_code == 404
    grant.read_transcript = True
    grant.save()
    assert client.get(path).data["can_generate"] is False
    for endpoint in endpoints:
        assert client.get(endpoint).status_code == 200
    assert (
        client.post(
            path,
            {
                "key": str(uuid.uuid4()),
                "target": "en",
                "expected_revision": record.revision,
            },
            format="json",
        ).status_code
        == 403
    )
    grant.delete()
    for endpoint in endpoints:
        assert client.get(endpoint).status_code == 404


def test_correction_snapshot_stale_export_and_new_version():
    owner, record, path = setup()
    job = prepare(owner, record)
    finish(job)
    original = record.original_segments.get()
    response = client_for(owner).patch(
        f"/api/v1.0/meeting-records/{record.pk}/original-segments/{original.pk}/",
        {"text": "Corrected words", "expected_revision": 0},
        format="json",
    )
    assert response.status_code == 200
    assert client_for(owner).get(path + str(job.pk) + "/").data["stale"] is True
    assert client_for(owner).get(path + str(job.pk) + "/export/").status_code == 409
    record.refresh_from_db()
    fresh = prepare(owner, record)
    assert fresh.pk != job.pk
    assert fresh.source[0]["text"] == "Corrected words"
    assert job.source[0]["text"] == "Original words"


@pytest.mark.parametrize(
    "raw,code",
    [
        ('{"segments":[]}', "output_segment_count_mismatch"),
        (
            '{"segments":[{"id":"invented","text":"hello"}]}',
            "output_segment_id_mismatch",
        ),
        ("not json", "output_invalid_json"),
    ],
)
def test_missing_or_forged_rows_never_publish_and_retry_is_explicit(raw, code):
    owner, record, _ = setup()
    job = prepare(owner, record)
    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.return_value = raw
        service.execute(job.pk)
        service.execute(job.pk)
        assert llm.return_value.chat.call_count == 1
    job.refresh_from_db()
    assert job.status == "failed" and job.content == [] and job.error_code == code
    assert prepare(owner, record, key=job.key).pk == job.pk
    assert prepare(owner, record).pk != job.pk


def test_revision_changed_during_provider_call_discards_output():
    owner, record, _ = setup()
    job = prepare(owner, record)

    def changed(**kwargs):
        models.MeetingRecord.objects.filter(pk=record.pk).update(
            revision=record.revision + 1
        )
        return output(**kwargs)

    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = changed
        service.execute(job.pk)
    job.refresh_from_db()
    assert job.status == "canceled" and job.content == []


def test_deadline_release_no_automatic_paid_retry_and_record_cascade():
    owner, record, path = setup()
    job = prepare(owner, record)
    job.deadline = timezone.now() - timedelta(seconds=1)
    job.save()
    assert client_for(owner).get(path).data["results"][0]["status"] == "incomplete"
    with patch.object(service, "LLMClient") as llm:
        service.execute(job.pk)
        assert not llm.called
    record.deleted_at = timezone.now()
    record.save()
    assert client_for(owner).get(path).status_code == 404
    record.delete()
    assert not models.UploadTranscriptTranslation.objects.filter(pk=job.pk).exists()


def test_complete_chunk_plan_and_budget_fail_closed():
    rows = [{"segment_id": str(i), "text": "word " * 800} for i in range(33)]
    plan = service.chunks(rows)
    assert [row for batch in plan for row in batch] == rows
    with pytest.raises(ValueError, match="source_budget_exceeded"):
        service.chunks([{"text": "x" * 6001}])
    with pytest.raises(ValueError, match="source_budget_exceeded"):
        service.chunks(rows * 3)


def test_full_batch_template_preserves_repeated_fragments_and_publication_order():
    owner, record, _ = setup()
    job = prepare(owner, record, target="en")
    texts = ["对吧？", "那么这个", "x²y", "对吧？"] * 11
    job.source = [
        {**job.source[0], "segment_id": str(uuid.uuid4()), "text": text}
        for text in texts
    ]
    job.segment_count, job.total_chunks = 44, 3
    job.save()
    assert job.configuration["prompt_version"] == 2
    seen = []

    def translate(**kwargs):
        body = json.loads(kwargs["user"])
        template = body["output_template"]
        assert body["target"] == "English"
        assert len(template["segments"]) == body["expected_segments"]
        assert [row["id"] for row in template["segments"]] == [
            row["id"] for row in body["segments"]
        ]
        seen.extend(body["segments"])
        for row in template["segments"]:
            assert row["text"] == ""
            row["text"] = "Translation for " + row["id"]
        return json.dumps(template)

    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = translate
        service.execute(job.pk)
        service.execute(job.pk)
        requests = llm.return_value.chat.call_args_list
    assert [
        json.loads(call.kwargs["user"])["expected_segments"] for call in requests
    ] == [20, 20, 4]
    assert [row["text"] for row in seen] == texts
    assert [row["id"] for row in seen] == [row["segment_id"] for row in job.source]
    job.refresh_from_db()
    assert job.status == "succeeded" and job.completed_chunks == 3
    assert job.content == ["Translation for " + row["id"] for row in seen]


@pytest.mark.parametrize("difference", [-1, 1])
@pytest.mark.parametrize("failed_chunk", [1, 2])
def test_batch_count_mismatch_discards_all_output_without_retry(
    difference, failed_chunk, caplog
):
    owner, record, path = setup()
    job = prepare(owner, record)
    job.source = [{**job.source[0], "segment_id": str(uuid.uuid4())} for _ in range(44)]
    job.segment_count, job.total_chunks = 44, 3
    job.save()
    calls = 0

    def mismatch(**kwargs):
        nonlocal calls
        calls += 1
        body = json.loads(output(**kwargs))
        if calls == failed_chunk:
            if difference < 0:
                body["segments"].pop()
            else:
                body["segments"].append(body["segments"][0])
        return json.dumps(body)

    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = mismatch
        service.execute(job.pk)
        service.execute(job.pk)
    job.refresh_from_db()
    assert job.status == "failed" and job.content == []
    assert job.error_code == "output_segment_count_mismatch"
    assert calls == failed_chunk and job.completed_chunks == failed_chunk - 1
    logs = [r for r in caplog.records if r.name == service.__name__]
    event = json.loads(logs[-1].getMessage().split(": ", 1)[1])
    assert event["chunk_index"] == failed_chunk
    assert event["expected_segments"] == 20
    assert event["actual_segments"] == 20 + difference
    expected = {
        "prompt_version": 2,
        "chunk_index": failed_chunk,
        "expected_segments": 20,
        "actual_segments": 20 + difference,
    }
    assert job.configuration["failure_diagnostics"] == expected
    client = client_for(owner)
    assert client.get(path).data["results"][0]["error_details"] == expected
    assert client.get(path + str(job.pk) + "/").data["error_details"] == expected


def test_error_details_exclude_arbitrary_configuration_and_non_numeric_values():
    owner, record, path = setup()
    job = prepare(owner, record)
    job.status = "failed"
    job.configuration["failure_diagnostics"] = {
        "expected_segments": 20,
        "actual_segments": 0,
        "chunk_index": "private provider error",
        "segment_index": -1,
        "prompt_version": True,
        "raw_output": "secret original text",
        "api_key": "secret-token",
    }
    job.save()
    response = client_for(owner).get(path).data["results"][0]
    assert response["error_details"] == {"expected_segments": 20, "actual_segments": 0}
    assert "secret" not in json.dumps(response)
    assert "private provider" not in json.dumps(response)
    job.configuration["failure_diagnostics"] = "private provider error"
    job.save()
    assert client_for(owner).get(path).data["results"][0]["error_details"] == {}


def test_legacy_failed_job_has_no_invented_diagnostic_counts():
    owner, record, path = setup()
    job = prepare(owner, record)
    job.status = "failed"
    job.error_code = "invalid_output"
    job.save()
    assert client_for(owner).get(path).data["results"][0]["error_details"] == {}


def test_already_queued_job_keeps_its_prompt_version():
    owner, record, _ = setup()
    job = prepare(owner, record)
    job.configuration["prompt_version"] = 1
    job.save()
    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = output
        service.execute(job.pk)
        request = llm.return_value.chat.call_args.kwargs
    assert request["system"] == service.LEGACY_SYSTEM
    assert set(json.loads(request["user"])) == {"target", "segments"}
    job.refresh_from_db()
    assert job.status == "succeeded"


def test_dispatch_failure_is_recoverable_and_repeat_dispatch_is_bounded():
    owner, record, _ = setup()
    job = prepare(owner, record)
    with patch(
        "meet.celery_app.app.connection_for_write", side_effect=RuntimeError("redacted")
    ) as broker:
        service.dispatch(job.pk)
        service.dispatch(job.pk)
        assert broker.call_count == 1
    job.refresh_from_db()
    assert job.status == "queued" and job.error_code == "dispatch_unavailable"
    job.dispatched_at = timezone.now() - timedelta(minutes=2)
    job.save()
    with patch("meet.celery_app.app.connection_for_write") as broker:
        with patch("meet.celery_app.app.send_task") as send:
            service.tick()
            assert broker.called and send.call_count == 1


def test_multichunk_all_segments_paginated_and_late_failure_not_partial():
    owner, record, path = setup()
    job = prepare(owner, record)
    job.source = [
        {**job.source[0], "segment_id": str(uuid.uuid4()), "text": f"Original {i}"}
        for i in range(51)
    ]
    job.total_chunks = len(service.chunks(job.source))
    job.segment_count = len(job.source)
    job.save()
    finish(job)
    client = client_for(owner)
    first = client.get(path + str(job.pk) + "/?page=0").data
    second = client.get(path + str(job.pk) + "/?page=1").data
    assert len(first["results"]) == 50 and first["next_page"] == 1
    assert len(second["results"]) == 1 and second["next_page"] is None
    assert second["results"][0]["text"] == "Original 50"
    other = prepare(owner, record, target="en")
    other.source = job.source
    other.total_chunks = job.total_chunks
    other.segment_count = job.segment_count
    other.save()
    calls = 0

    def partial(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("provider secret")
        return output(**kwargs)

    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = partial
        service.execute(other.pk)
    other.refresh_from_db()
    assert other.status == "failed" and other.content == []
    detail = client.get(path + str(other.pk) + "/").data
    assert detail["results"] == [] and "provider secret" not in json.dumps(detail)


def test_access_or_rollout_change_prevents_provider_request(settings):
    owner, record, _ = setup()
    job = prepare(owner, record)
    settings.UPLOAD_TRANSCRIPT_TRANSLATION_ENABLED = False
    with patch.object(service, "LLMClient") as llm:
        service.execute(job.pk)
        assert not llm.return_value.chat.called
    job.refresh_from_db()
    assert job.status == "canceled" and job.content == []


def test_new_request_cannot_overlap_an_active_translation():
    owner, record, path = setup()
    prepare(owner, record)
    response = client_for(owner).post(
        path,
        {
            "key": str(uuid.uuid4()),
            "target": "en",
            "expected_revision": record.revision,
        },
        format="json",
    )
    assert response.status_code == 409
    assert record.upload_translations.count() == 1


@pytest.mark.parametrize(
    "segments,code",
    [
        (None, "output_schema_mismatch"),
        ([], "output_segment_count_mismatch"),
        (
            [{"id": "b", "text": "B"}, {"id": "a", "text": "A"}],
            "output_segment_order_mismatch",
        ),
        (
            [{"id": "a", "text": "A"}, {"id": "a", "text": "B"}],
            "output_segment_id_mismatch",
        ),
        (
            [{"id": "a", "text": "A"}, {"id": "invented", "text": "B"}],
            "output_segment_id_mismatch",
        ),
        ([{"id": "a", "text": ""}, {"id": "b", "text": "B"}], "output_empty_text"),
        (
            [{"id": "a", "text": "x" * 24001}, {"id": "b", "text": "B"}],
            "output_text_too_long",
        ),
        (
            [{"id": "a", "text": "A", "extra": "private"}, {"id": "b", "text": "B"}],
            "output_schema_mismatch",
        ),
    ],
)
def test_precise_output_validation_codes(segments, code):
    with pytest.raises(service.TranslationOutputError) as error:
        service.validate(
            json.dumps({"segments": segments}),
            [{"segment_id": "a"}, {"segment_id": "b"}],
        )
    assert error.value.code == code
    assert "private" not in str(error.value)


@pytest.mark.parametrize(
    "reason,code",
    [("length", "output_truncated"), ("content_filter", "output_not_complete")],
)
def test_completion_error_is_classified_without_partial_publication(
    reason, code, caplog
):
    owner, record, path = setup()
    job = prepare(owner, record)
    job.source = [{**job.source[0], "segment_id": str(uuid.uuid4())} for _ in range(44)]
    job.total_chunks = 3
    job.segment_count = 44
    job.save()
    calls = 0

    def partial(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise LLMIncompleteOutput(reason)
        return output(**kwargs)

    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = partial
        service.execute(job.pk)
        service.execute(job.pk)
    job.refresh_from_db()
    assert job.completed_chunks == 1 and job.error_code == code and job.content == []
    assert calls == 2
    response = client_for(owner).get(path).data["results"][0]
    assert response["error_code"] == code
    logs = [r for r in caplog.records if r.name == service.__name__]
    event = json.loads(logs[-1].getMessage().split(": ", 1)[1])
    assert event["chunk_index"] == 2 and event["expected_segments"] == 20
    assert event["finish_reason"] == reason
    assert (
        "Original words" not in caplog.text
        and "Translated <content>" not in caplog.text
    )
    assert logs[-1].exc_info is None


@pytest.mark.parametrize(
    "kind,code",
    [
        ("timeout", "provider_timeout"),
        ("connection", "provider_connection_failed"),
        (401, "provider_auth_failed"),
        (403, "provider_auth_failed"),
        (429, "provider_rate_limited"),
        (500, "provider_http_error"),
        ("unexpected", "provider_unavailable"),
    ],
)
def test_provider_errors_are_sanitized(kind, code, caplog):
    owner, record, _ = setup()
    job = prepare(owner, record)
    request = httpx.Request("POST", "https://secret.invalid/?key=secret-token")
    if kind == "timeout":
        error = APITimeoutError(request=request)
    elif kind == "connection":
        error = APIConnectionError(request=request, message="private provider error")
    elif isinstance(kind, int):
        error = APIStatusError(
            "private provider error",
            response=httpx.Response(kind, request=request),
            body={"secret": "secret-token"},
        )
    else:
        error = ValueError("private provider error")
    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.side_effect = error
        service.execute(job.pk)
    job.refresh_from_db()
    assert job.error_code == code and job.content == []
    assert "private provider" not in caplog.text and "secret-token" not in caplog.text
    assert "secret.invalid" not in caplog.text
