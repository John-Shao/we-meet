"""Whole-upload translation: ACL, revision, complete output and paid replay fences."""

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import upload_translations as service
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
    "raw",
    ['{"segments":[]}', '{"segments":[{"id":"invented","text":"hello"}]}', "not json"],
)
def test_missing_or_forged_rows_never_publish_and_retry_is_explicit(raw):
    owner, record, _ = setup()
    job = prepare(owner, record)
    with patch.object(service, "LLMClient") as llm:
        llm.return_value.chat.return_value = raw
        service.execute(job.pk)
        service.execute(job.pk)
        assert llm.return_value.chat.call_count == 1
    job.refresh_from_db()
    assert (
        job.status == "failed"
        and job.content == []
        and job.error_code == "invalid_output"
    )
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
