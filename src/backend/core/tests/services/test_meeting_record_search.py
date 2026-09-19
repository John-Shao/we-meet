"""Search uses full authorized originals and rejects stale revision pagination."""

from datetime import timedelta
from unittest.mock import patch

import pytest

from core import models
from core.api.meeting_records import RecordTranscriptSerializer
from core.factories import UserFactory
from core.tests.services.test_capture_transcription import (
    acknowledge,
    enabled,
    final,
    finish,
    running,
)
from core.tests.services.test_meeting_records import client_for, online_note

pytestmark = pytest.mark.django_db


def test_playback_window_locates_beyond_page_one_and_preserves_cursor_and_acl():
    owner, capture, worker, job = running()
    for index in range(65):
        response, _ = final(
            job["id"], worker, sequence=index + 1,
            start_ms=index * 10, end_ms=index * 10 + 5, text=f"line {index}",
        )
        assert response.status_code == 201
    acknowledge(job, worker)
    assert finish(job["id"], worker, count=65).data["status"] == "succeeded"
    client = client_for(owner)
    path = f"/api/v1.0/meeting-records/{capture.record_id}/original-segments/"
    params = {"at_ms": 153, "transcription_job_id": job["id"]}
    page = client.get(path, params).data
    assert len(page["results"]) == 30
    assert page["results"][0]["start_ms"] == 150
    continued = client.get(path, {**params, "cursor": page["next_cursor"]}).data
    assert continued["results"][0]["start_ms"] == 450
    assert continued["next_cursor"] is None
    # A seek in silence keeps the preceding utterance for context.
    assert client.get(path, {"at_ms": 458}).data["results"][0]["start_ms"] == 450
    assert client.get(path, {"at_ms": 9999}).data["results"][0]["start_ms"] == 640
    assert client.get(path, {"at_ms": 0}).data["results"][0]["start_ms"] == 0
    assert client.get(path, {"at_ms": 450, "q": "line 2"}).data["results"][0]["text"] == "line 29"
    for invalid in (-1, "bad", "9223372036854775808"):
        assert client.get(path, {"at_ms": invalid}).status_code == 400
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(record=capture.record, user=reader, read_summary=True)
    assert client_for(reader).get(path, {"at_ms": 450}).status_code == 403
    assert client_for(UserFactory()).get(path, {"at_ms": 450}).status_code == 404
    capture.record.refresh_from_db()
    assert client.get(path, {"at_ms": 450, "expected_revision": capture.record.revision + 1}).status_code == 409


def test_search_covers_rows_beyond_first_page_without_crossing_reused_room():
    owner, session, original, record = online_note(text="first unrelated line")
    for index in range(35):
        models.Transcript.objects.create(
            room=session.room, session=session, text=f"row {index}",
            speaker_identity=str(owner.pk),
            started_at=original.started_at + timedelta(seconds=index+1),
        )
    match = models.Transcript.objects.create(
        room=session.room, session=session, text="Budget & 中文: QWEN 100% _literal",
        speaker_identity=str(owner.pk),
        started_at=original.started_at + timedelta(seconds=99),
    )
    online_note(user=owner, room=session.room, text="QWEN private other session")
    record.refresh_from_db()
    client = client_for(owner)
    path = f"/api/v1.0/meeting-records/{record.pk}/transcripts/"
    for query in ("qwen", "中文", "100% _", "&"):
        response = client.get(path, {"q": query, "expected_revision": record.revision})
        assert response.status_code == 200
        assert [row["id"] for row in response.data["results"]] == [str(match.pk)]
    assert client.get(path, {"q": "literal-that-does-not-exist"}).data["results"] == []


def test_filter_bounds_and_summary_only_access_are_checked_before_search():
    _, _, _, record = online_note(text="hidden text")
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(record=record, user=reader, read_summary=True)
    path = f"/api/v1.0/meeting-records/{record.pk}/transcripts/"
    assert client_for(reader).get(path, {"q": "hidden", "expected_revision": 0}).status_code == 403
    owner, _, _, own = online_note()
    path = f"/api/v1.0/meeting-records/{own.pk}/transcripts/"
    for params in ({"q": "a"*201}, {"expected_revision": 0}, {"expected_revision": "invalid"}):
        assert client_for(owner).get(path, params).status_code == 400


def test_stale_revision_and_publication_during_serialization_fail_closed():
    owner, _, _, record = online_note()
    path = f"/api/v1.0/meeting-records/{record.pk}/transcripts/"
    client = client_for(owner)
    assert client.get(path, {"expected_revision": record.revision+1}).status_code == 409
    original = RecordTranscriptSerializer.to_representation

    def changed(serializer, instance):
        models.MeetingRecord.objects.filter(pk=record.pk).update(revision=record.revision+1)
        return original(serializer, instance)

    with patch.object(RecordTranscriptSerializer, "to_representation", changed):
        response = client.get(path, {"expected_revision": record.revision})
    assert response.status_code == 409
    assert "results" not in response.data
    assert response["Cache-Control"] == "private, no-store"


def test_native_search_never_exposes_unpublished_originals():
    owner, capture, worker, job = running()
    assert final(job["id"], worker, text="Release 中文 decision")[0].status_code == 201
    path = f"/api/v1.0/meeting-records/{capture.record_id}/original-segments/"
    client = client_for(owner)
    assert client.get(path, {"q": "release"}).data["results"] == []
    acknowledge(job, worker)
    assert finish(job["id"], worker).data["status"] == "succeeded"
    capture.record.refresh_from_db()
    revision = capture.record.revision
    result = client.get(path, {"q": "中文", "transcription_job_id": job["id"]})
    assert len(result.data["results"]) == 1
    assert client.get(path, {"expected_revision": revision-1}).status_code == 409
    assert len(client.get(path, {"expected_revision": revision, "q": "release"}).data["results"]) == 1
    models.MeetingRecord.objects.filter(pk=capture.record_id).update(revision=revision+1)
    # Explicit successful generations remain readable across later record revisions.
    assert len(client.get(path, {"transcription_job_id": job["id"], "q": "release"}).data["results"]) == 1
