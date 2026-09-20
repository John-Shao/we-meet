"""Whole-record atomic corrections, replay safety and non-destructive undo."""

import uuid
from concurrent.futures import ThreadPoolExecutor

from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import transcript_corrections as corrections
from core.services import transcript_replacements as service
from core.services.effective_transcripts import originals
from core.services.transcript_export import rows_for
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_transcript_correction_api import captured

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True


def path(record):
    return f"/api/v1.0/meeting-records/{record.pk}/transcript-replacements/"


def prepare(user, record, find="word", replacement="world"):
    response = client_for(user).post(
        path(record) + "preview/",
        {"find": find, "replacement": replacement},
        format="json",
    )
    assert response.status_code == 200, response.data
    return response.data, {
        "key": str(uuid.uuid4()),
        "find": find,
        "replacement": replacement,
        "expected_hash": response.data["preview_hash"],
    }


def extra(record, first, sequence, text):
    return models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=first.capture_session,
        speaker=first.speaker,
        ingest_id=uuid.uuid4(),
        source_track_id="track",
        source_sequence=sequence,
        start_ms=sequence * 1000,
        end_ms=sequence * 1000 + 500,
        text=text,
        payload_hash="0" * 64,
    )


def test_preview_covers_more_than_one_page_and_changes_nothing():
    user, record, first = captured()
    for number in range(2, 34):
        extra(record, first, number, "word word")
    preview, body = prepare(user, record)
    assert len(preview["changes"]) == 33
    assert preview["occurrences"] == 65
    assert models.MeetingOriginalRevision.objects.count() == 0
    before_revision = record.revision
    response = client_for(user).post(path(record), body, format="json")
    assert response.status_code == 200, response.data
    record.refresh_from_db()
    assert record.revision == before_revision + 1
    assert models.MeetingOriginalRevision.objects.count() == 33
    assert all("world" in row.corrected_text for row in originals(record))
    first.refresh_from_db()
    assert first.text == "Hello word."


def test_lost_response_replay_and_replay_after_undo_do_not_reapply():
    user, record, segment = captured()
    _, body = prepare(user, record)
    client = client_for(user)
    applied = client.post(path(record), body, format="json")
    replay = client.post(path(record), body, format="json")
    assert applied.data == replay.data
    undo = path(record) + applied.data["id"] + "/undo/"
    assert client.post(undo).data["undone"] is True
    assert client.post(undo).data["undone"] is True
    assert client.post(path(record), body, format="json").data["undone"] is True
    assert segment.revisions.count() == 2
    assert corrections.corrected_text(segment) == segment.text
    changed = client.post(
        path(record), {**body, "replacement": "different"}, format="json"
    )
    assert changed.status_code == 409


def test_stale_preview_is_rejected_before_any_batch_change():
    user, record, segment = captured()
    second = extra(record, segment, 2, "word")
    _, body = prepare(user, record)
    corrections.correct(record, second.pk, user, text="someone else")
    response = client_for(user).post(path(record), body, format="json")
    assert response.status_code == 409
    assert segment.revisions.count() == 0
    assert models.TranscriptReplacement.objects.count() == 0


def test_undo_restores_previous_human_text_not_asr_and_preserves_unrelated_edits():
    user, record, segment = captured()
    second = extra(record, segment, 2, "unrelated")
    corrections.correct(record, segment.pk, user, text="Human word")
    record.refresh_from_db()
    _, body = prepare(user, record)
    response = client_for(user).post(path(record), body, format="json")
    corrections.correct(record, second.pk, user, text="later independent edit")
    undone = client_for(user).post(path(record) + response.data["id"] + "/undo/")
    assert undone.status_code == 200
    assert corrections.corrected_text(segment) == "Human word"
    assert corrections.corrected_text(second) == "later independent edit"


def test_undo_conflict_does_not_partially_restore_or_overwrite_later_edit():
    user, record, segment = captured()
    second = extra(record, segment, 2, "word")
    _, body = prepare(user, record)
    response = client_for(user).post(path(record), body, format="json")
    corrections.correct(record, second.pk, user, text="later edit")
    undone = client_for(user).post(path(record) + response.data["id"] + "/undo/")
    assert undone.status_code == 409
    assert corrections.corrected_text(segment) == "Hello world."
    assert corrections.corrected_text(second) == "later edit"
    assert models.TranscriptReplacement.objects.get().undone_at is None


@pytest.mark.parametrize(
    "find,replacement",
    [("", "x"), ("word", "word"), ("word", "x" * 201), ("Hello word.", "")],
)
def test_invalid_preview_never_writes(find, replacement):
    user, record, segment = captured()
    response = client_for(user).post(
        path(record) + "preview/",
        {"find": find, "replacement": replacement},
        format="json",
    )
    assert response.status_code == 400
    assert segment.revisions.count() == 0


def test_literal_matching_does_not_treat_percent_underscore_or_regex_as_patterns():
    user, record, segment = captured(text="100%_x.* and 100AXzz word WORD")
    preview, _ = prepare(user, record, "%_x.*", "ok")
    assert preview["changes"][0]["after"] == "100ok and 100AXzz word WORD"
    preview, _ = prepare(user, record)
    assert preview["occurrences"] == 1


def test_size_bound_rejects_instead_of_truncating():
    user, record, first = captured()
    for number in range(2, 102):
        extra(record, first, number, "word")
    response = client_for(user).post(
        path(record) + "preview/",
        {"find": "word", "replacement": "world"},
        format="json",
    )
    assert response.status_code == 400
    assert models.MeetingOriginalRevision.objects.count() == 0


def test_read_only_and_other_record_cannot_access_history_preview_apply_or_undo():
    user, record, segment = captured()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_transcript=True
    )
    _, body = prepare(user, record)
    applied = client_for(user).post(path(record), body, format="json")
    client = client_for(reader)
    assert client.get(path(record)).status_code == 403
    assert (
        client.post(path(record) + "preview/", body, format="json").status_code == 403
    )
    assert client.post(path(record), body, format="json").status_code == 403
    assert client.post(path(record) + applied.data["id"] + "/undo/").status_code == 403
    _, other, _ = captured(owner=user)
    assert (
        client_for(user).post(path(other) + applied.data["id"] + "/undo/").status_code
        == 404
    )
    assert segment.revisions.count() == 1


def test_a_receipt_failure_rolls_back_the_whole_batch(monkeypatch):
    user, record, segment = captured()
    preview, body = prepare(user, record)

    def fail(**_kwargs):
        raise RuntimeError("receipt storage failed")

    monkeypatch.setattr(models.TranscriptReplacement.objects, "create", fail)
    with pytest.raises(RuntimeError):
        service.apply(record, user, **body)
    assert segment.revisions.count() == 0
    record.refresh_from_db()
    assert record.revision == preview["record_revision"]


def test_deleting_a_term_updates_export_and_history_without_exposing_text_copies():
    user, record, segment = captured()
    _, body = prepare(user, record, "word", "")
    client = client_for(user)
    assert client.post(path(record), body, format="json").status_code == 200
    assert rows_for(record)[0].text == "Hello ."
    history = client.get(path(record))
    assert history.status_code == 200
    assert history.data["results"][0]["replacement"] == ""
    assert "changes" not in history.data["results"][0]
    assert segment.text == "Hello word."


def test_no_matches_cannot_create_an_empty_receipt():
    user, record, _ = captured()
    proposed, body = prepare(user, record, "absent", "new")
    assert proposed["changes"] == []
    assert client_for(user).post(path(record), body, format="json").status_code == 400
    assert not models.TranscriptReplacement.objects.exists()


@pytest.mark.parametrize("text,count", [("word " * 2000, 1), ("word " * 900, 50)])
def test_result_and_total_payload_bounds_reject_whole_preview(text, count):
    user, record, first = captured(text=text)
    for number in range(2, count + 1):
        extra(record, first, number, text)
    response = client_for(user).post(
        path(record) + "preview/",
        {"find": "word", "replacement": "x" * 20 if count == 1 else "world"},
        format="json",
    )
    assert response.status_code == 400
    assert not models.MeetingOriginalRevision.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_identical_requests_commit_once():
    user, record, segment = captured()
    _, body = prepare(user, record)

    def submit():
        close_old_connections()
        try:
            return service.apply(record, user, **body).pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert results[0] == results[1]
    assert segment.revisions.count() == 1
    assert models.TranscriptReplacement.objects.count() == 1


@pytest.mark.parametrize("apply_first", [False, True])
def test_republished_asr_generation_blocks_old_preview_and_undo(apply_first):
    user, record, segment = captured()
    capture = segment.capture_session
    job = models.CaptureTranscriptionJob.objects.create(
        capture=capture,
        requested_by=user,
        key=uuid.uuid4(),
        request_hash="a" * 64,
        generation=1,
        inputs={"fixture": True},
        configuration={"fixture": True},
        status="succeeded",
        deadline=timezone.now(),
    )
    models.MeetingOriginalSegment.objects.filter(pk=segment.pk).update(
        transcription_job=job
    )
    models.CaptureSession.objects.filter(pk=capture.pk).update(active_transcription=job)
    _, body = prepare(user, record)
    client = client_for(user)
    applied = client.post(path(record), body, format="json") if apply_first else None
    # Replacing the published generation removes the old rows from the current projection.
    models.CaptureSession.objects.filter(pk=capture.pk).update(
        active_transcription=None
    )
    response = (
        client.post(path(record) + applied.data["id"] + "/undo/")
        if apply_first
        else client.post(path(record), body, format="json")
    )
    assert response.status_code == 409
    assert segment.revisions.count() == int(apply_first)
