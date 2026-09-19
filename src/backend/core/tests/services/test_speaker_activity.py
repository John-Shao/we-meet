"""Speaker time is measured over published intervals, never per result page."""

import uuid

import pytest

from core import models
from core.api.meeting_records import RecordPagination
from core.services import speaker_activity
from core.tests.services.test_meeting_record_speakers import capture_with_speakers
from core.tests.services.test_meeting_records import audio_note, client_for

pytestmark = pytest.mark.django_db
PATH = "/api/v1.0/meeting-records/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True


def add(record, capture, speaker, start, end):
    return models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=capture,
        speaker=speaker,
        ingest_id=uuid.uuid4(),
        source_track_id=speaker.source_track_id,
        source_sequence=start,
        start_ms=start,
        end_ms=end,
        text="extra",
        payload_hash="b" * 64,
    )


def test_overlap_merges_per_speaker_and_unassigned_time_stays_in_denominator():
    record = audio_note()
    capture, speakers = capture_with_speakers(record)
    add(record, capture, speakers[0], 500, 1500)
    unknown = models.MeetingSpeaker.objects.create(
        record=record,
        capture_session=capture,
        source_track_id="unknown",
        source_key="unknown",
        identity_type="unknown",
        label="Unknown",
    )
    add(record, capture, unknown, 2000, 2500)
    stats, status = speaker_activity.activity(record)
    assert status == "available"
    assert stats[speakers[0].pk] == {"duration_ms": 1500, "share_percent": 50.0}
    assert stats[speakers[1].pk]["duration_ms"] == 1000
    assert stats[unknown.pk]["duration_ms"] == 500


def test_null_end_is_excluded_and_marks_all_estimates_partial():
    record = audio_note()
    capture, speakers = capture_with_speakers(record)
    add(record, capture, speakers[0], 3000, None)
    response = client_for(record.owner).get(f"{PATH}{record.pk}/speakers/")
    assert response.status_code == 200
    for row in response.json()["results"]:
        assert row["activity"] == {
            "basis": "recognized_speaker_time",
            "status": "partial",
            "duration_ms": 1000,
            "share_percent": 50.0,
        }


def test_stats_use_whole_record_even_when_speaker_results_are_paginated(monkeypatch):
    record = audio_note()
    capture_with_speakers(record)
    monkeypatch.setattr(RecordPagination, "page_size", 1)
    client = client_for(record.owner)
    first = client.get(f"{PATH}{record.pk}/speakers/").json()
    assert first["next_cursor"]
    second = client.get(
        f"{PATH}{record.pk}/speakers/", {"cursor": first["next_cursor"]}
    ).json()
    assert first["results"][0]["activity"]["share_percent"] == 50.0
    assert second["results"][0]["activity"]["share_percent"] == 50.0


def test_budget_does_not_report_a_partial_scan_as_complete(monkeypatch):
    record = audio_note()
    capture_with_speakers(record)
    monkeypatch.setattr(speaker_activity, "MAX_ACTIVITY_SEGMENTS", 1)
    body = client_for(record.owner).get(f"{PATH}{record.pk}/speakers/").json()
    for row in body["results"]:
        assert row["activity"]["status"] == "unavailable"
        assert row["activity"]["duration_ms"] is None
        assert row["activity"]["share_percent"] is None


def test_upload_speakers_do_not_require_native_capture_rollout(settings):
    record = audio_note()
    record = models.MeetingRecord.objects.create(
        owner=record.owner,
        source_type="upload",
        title="Import",
        origin_at=record.origin_at,
        retention_mode="media",
    )
    capture_with_speakers(record)
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = False
    assert (
        client_for(record.owner).get(f"{PATH}{record.pk}/speakers/").status_code == 200
    )


def test_source_change_during_statistics_returns_conflict(monkeypatch):
    record = audio_note()
    capture_with_speakers(record)
    original = speaker_activity.activity

    def changed(source):
        stats = original(source)
        models.MeetingRecord.objects.filter(pk=record.pk).update(
            revision=record.revision + 1
        )
        return stats

    monkeypatch.setattr(speaker_activity, "activity", changed)
    assert (
        client_for(record.owner).get(f"{PATH}{record.pk}/speakers/").status_code == 409
    )
