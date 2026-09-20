"""Speaker time is measured over published intervals, never per result page."""

import uuid

import pytest

from core import models
from core.api.meeting_records import RecordPagination
from core.factories import UserFactory
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
    assert stats[speakers[0].pk]["duration_ms"] == 1500
    assert stats[speakers[0].pk]["share_percent"] == 50.0
    assert stats[speakers[0].pk]["timeline"]["intervals"] == [
        {"start_ms": 0, "end_ms": 1500}
    ]
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
            "timeline": {
                "basis": "recognized_extent",
                "status": "partial",
                "reason": None,
                "extent_ms": 2000,
                "intervals": [{"start_ms": 0, "end_ms": 1000}]
                if row["id"] == str(speakers[0].pk)
                else [{"start_ms": 1000, "end_ms": 2000}],
            },
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
    assert first["results"][0]["activity"]["timeline"]["extent_ms"] == 2000
    assert second["results"][0]["activity"]["timeline"]["extent_ms"] == 2000


def test_timeline_keeps_silence_and_overlapping_different_speakers():
    record = audio_note()
    capture, speakers = capture_with_speakers(record)
    add(record, capture, speakers[0], 4000, 6000)
    add(record, capture, speakers[1], 5000, 7000)
    stats, _ = speaker_activity.activity(record)
    assert stats[speakers[0].pk]["timeline"] == {
        "basis": "recognized_extent",
        "status": "available",
        "reason": None,
        "extent_ms": 7000,
        "intervals": [
            {"start_ms": 0, "end_ms": 1000},
            {"start_ms": 4000, "end_ms": 6000},
        ],
    }
    assert stats[speakers[1].pk]["timeline"]["intervals"][-1] == {
        "start_ms": 5000,
        "end_ms": 7000,
    }


def test_distinct_capture_clocks_have_stats_but_no_shared_timeline():
    record = audio_note()
    capture_with_speakers(record)
    capture_with_speakers(record)
    stats, status = speaker_activity.activity(record)
    assert status == "available"
    for row in stats.values():
        assert row["timeline"] == {
            "basis": "recognized_extent",
            "status": "unavailable",
            "reason": "multiple_clocks",
            "extent_ms": None,
            "intervals": [],
        }


def test_timeline_limit_disables_chart_without_truncating_stats(monkeypatch):
    record = audio_note()
    capture_with_speakers(record)
    monkeypatch.setattr(speaker_activity, "MAX_TIMELINE_INTERVALS", 1)
    stats, status = speaker_activity.activity(record)
    assert status == "available"
    for row in stats.values():
        assert row["duration_ms"] == 1000
        assert row["timeline"]["reason"] == "interval_limit"
        assert row["timeline"]["intervals"] == []


def test_missing_end_is_never_guessed_for_a_timeline():
    record = audio_note()
    capture, speakers = capture_with_speakers(record)
    models.MeetingOriginalSegment.objects.filter(record=record).update(end_ms=None)
    stats, status = speaker_activity.activity(record)
    assert stats == {}
    assert status == "unavailable"


def test_unpublished_asr_retry_never_changes_timeline_extent():
    record = audio_note()
    capture, speakers = capture_with_speakers(record)
    job = models.CaptureTranscriptionJob.objects.create(
        capture=capture,
        requested_by=record.owner,
        key=uuid.uuid4(),
        request_hash="a" * 64,
        generation=1,
        inputs=[{"sequence": 1}],
        configuration={"language": "auto"},
        deadline=record.origin_at,
        status="running",
    )
    unpublished = add(record, capture, speakers[0], 9000, 10000)
    models.MeetingOriginalSegment.objects.filter(pk=unpublished.pk).update(
        transcription_job=job
    )
    stats, _ = speaker_activity.activity(record)
    assert stats[speakers[0].pk]["timeline"]["extent_ms"] == 2000
    assert stats[speakers[0].pk]["timeline"]["intervals"] == [
        {"start_ms": 0, "end_ms": 1000}
    ]


def test_timeline_inherits_transcript_authorization_and_revocation():
    record = audio_note()
    capture_with_speakers(record)
    reader = UserFactory()
    client = client_for(reader)
    assert client.get(f"{PATH}{record.pk}/speakers/").status_code in (403, 404)
    grant = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    assert client.get(f"{PATH}{record.pk}/speakers/").status_code == 403
    grant.read_transcript = True
    grant.save()
    response = client.get(f"{PATH}{record.pk}/speakers/")
    assert response.status_code == 200
    assert response.json()["results"][0]["activity"]["timeline"]["extent_ms"] == 2000
    grant.read_transcript = False
    grant.save()
    assert client.get(f"{PATH}{record.pk}/speakers/").status_code == 403


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
