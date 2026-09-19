"""The source a reader corrected must be the source downstream consumers use."""

import pytest

from core import models
from core.services import transcript_corrections, transcript_export
from core.services.meeting_records import RecordConflict
from core.services.meeting_search import recall_records
from core.services.meeting_summary_versions import (
    prepare_summary_job,
    source_is_current,
)
from core.tests.services.test_capture_summary import enabled, published
from core.tests.services.test_capture_transcription import (
    acknowledge,
    claim,
    control,
    final,
    finish,
    request_job,
)
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


def test_corrected_text_and_name_reach_new_snapshot_search_and_export():
    owner, capture, _ = published()
    record = capture.record
    original = record.original_segments.get()
    old_job = prepare_summary_job(record.pk)
    old_text = old_job.input_snapshot.segments[0]["text"]
    owner.full_name = ""
    owner.short_name = "Attributed person"
    owner.save(update_fields=["full_name", "short_name"])
    original.speaker.user = owner
    original.speaker.save()
    transcript_corrections.correct(
        record, original.pk, owner, text="corrected_unique_word", expected_revision=0
    )

    new_job = prepare_summary_job(record.pk, regenerate=True)
    row = new_job.input_snapshot.segments[0]
    assert row["text"] == "corrected_unique_word"
    assert row["speaker_name"] == original.speaker.display_name
    assert row["speaker_name"] == "Attributed person"
    assert (
        row["segment_revision"] > old_job.input_snapshot.segments[0]["segment_revision"]
    )
    old_job.input_snapshot.refresh_from_db()
    assert old_job.input_snapshot.segments[0]["text"] == old_text
    assert not source_is_current(old_job)
    assert source_is_current(new_job)

    path = f"/api/v1.0/meeting-records/{record.pk}/original-segments/"
    found = client_for(owner).get(path, {"q": "corrected_unique_word"})
    assert len(found.data["results"]) == 1
    assert found.data["results"][0]["correction_revision"] == 1
    assert recall_records(owner, ["corrected_unique_word"], [])
    assert not client_for(owner).get(path, {"q": old_text}).data["results"]
    assert not recall_records(owner, [old_text], [])
    exported = transcript_export.rows_for(record)
    assert exported[0].text == row["text"]
    assert exported[0].speaker == row["speaker_name"]


def test_export_uses_only_the_current_published_asr_generation():
    owner, capture, asr = published()
    assert request_job(owner, capture, expected=asr["id"]).status_code == 201
    worker, second = claim()
    assert control(second["id"], worker, "begin").status_code == 200
    assert (
        final(second["id"], worker, text="replacement generation")[0].status_code == 201
    )
    acknowledge(second, worker)
    assert finish(second["id"], worker).data["status"] == "succeeded"
    assert capture.record.original_segments.count() == 2
    assert [row.text for row in transcript_export.rows_for(capture.record)] == [
        "replacement generation"
    ]
    previous = capture.record.original_segments.exclude(
        transcription_job_id=second["id"]
    ).get()
    with pytest.raises(LookupError):
        transcript_corrections.correct(
            capture.record,
            previous.pk,
            owner,
            text="stale generation",
            expected_revision=0,
        )
    page = client_for(owner).get(
        f"/api/v1.0/meeting-records/{capture.record.pk}/original-segments/",
        {"transcription_job_id": asr["id"]},
    )
    assert page.status_code == 200
    assert page.data["results"][0]["can_correct"] is False


def test_restore_is_an_append_and_a_stale_restore_cannot_remove_new_edits():
    owner, capture, _ = published()
    record = capture.record
    row = record.original_segments.get()
    transcript_corrections.correct(
        record, row.pk, owner, text="first correction", expected_revision=0
    )
    transcript_corrections.correct(
        record, row.pk, owner, text="second correction", expected_revision=1
    )
    with pytest.raises(RecordConflict):
        transcript_corrections.revert(record, row.pk, owner, expected_revision=1)
    transcript_corrections.revert(record, row.pk, owner, expected_revision=2)
    assert list(row.revisions.order_by("revision").values_list("text", flat=True)) == [
        "first correction",
        "second correction",
        row.text,
    ]
    assert transcript_corrections.corrected_text(row) == row.text
    _, new = transcript_corrections.correct(
        record, row.pk, owner, text="third correction", expected_revision=3
    )
    assert new.revision == 4


def test_http_returns_fresh_record_and_correction_versions_and_guards_restore():
    owner, capture, _ = published()
    record = capture.record
    row = record.original_segments.get()
    path = f"/api/v1.0/meeting-records/{record.pk}/original-segments/{row.pk}/"
    response = client_for(owner).patch(
        path, {"text": "fixed", "expected_revision": 0}, format="json"
    )
    assert response.status_code == 200
    record.refresh_from_db()
    assert response.data["record_revision"] == record.revision
    assert response.data["correction_revision"] == 1
    stale = client_for(owner).delete(path + "?expected_revision=0")
    assert stale.status_code == 409
    restored = client_for(owner).delete(path + "?expected_revision=1")
    assert restored.status_code == 200
    assert restored.data["correction_revision"] == 2
    assert models.MeetingOriginalRevision.objects.filter(original=row).count() == 2
