"""Downloading a transcript as a file, with the reader's own access."""

import uuid

from datetime import timedelta

import pytest

from core import models
from core.factories import UserFactory
from core.services import transcript_export
from core.tests.services.test_meeting_records import (
    audio_note,
    client_for,
    online_note,
)


pytestmark = pytest.mark.django_db

EXPORT = "/api/v1.0/meeting-records/{}/transcript-export/"


@pytest.fixture(autouse=True)
def meeting_records_enabled(settings):
    """The record API answers 404 while the feature gate is off, by design."""
    settings.MEETING_RECORDS_ENABLED = True
    yield


def body(response):
    """FileResponse is streamed; it deliberately has no `.content`."""
    return b"".join(response.streaming_content).decode("utf-8")


def url(record, fmt=None):
    base = EXPORT.format(record.id)
    return f"{base}?as={fmt}" if fmt else base


def test_downloads_plain_text_by_default():
    user, _, _, record = online_note()
    response = client_for(user).get(url(record))
    assert response.status_code == 200
    assert response["Content-Type"] == "text/plain; charset=utf-8"
    assert "first meeting" in body(response)


def test_every_supported_format_carries_its_own_type_and_extension():
    user, _, _, record = online_note()
    expected = {
        "txt": ("text/plain; charset=utf-8", ".txt"),
        "srt": ("application/x-subrip; charset=utf-8", ".srt"),
        "vtt": ("text/vtt; charset=utf-8", ".vtt"),
    }
    for fmt, (content_type, extension) in expected.items():
        response = client_for(user).get(url(record, fmt))
        assert response.status_code == 200, fmt
        assert response["Content-Type"] == content_type
        assert extension in response["Content-Disposition"]


def test_a_chinese_record_title_survives_into_the_filename():
    """RFC 5987 encoding, not a crash and not a stripped name."""
    user, _, _, record = online_note()
    record.title = "中国老板"
    record.save(update_fields=["title"])
    response = client_for(user).get(url(record))
    assert response.status_code == 200
    disposition = response["Content-Disposition"]
    # Django emits both the ASCII fallback and the UTF-8 form.
    assert "filename*=utf-8''" in disposition.lower()
    assert "%E4%B8%AD" in disposition  # 中


def test_srt_carries_cue_timing_so_a_player_can_use_it():
    user, _, _, record = online_note()
    body_text = body(client_for(user).get(url(record, "srt")))
    assert body_text.startswith("1\n")
    assert "-->" in body_text


def test_an_unknown_format_is_rejected_rather_than_guessed():
    user, _, _, record = online_note()
    response = client_for(user).get(url(record, "pdf"))
    assert response.status_code == 400


def test_a_reader_without_transcript_access_gets_nothing():
    _, _, _, record = online_note()
    response = client_for(UserFactory()).get(url(record, "srt"))
    assert response.status_code == 404


def test_anonymous_is_denied():
    _, _, _, record = online_note()
    from rest_framework.test import APIClient

    assert APIClient().get(url(record)).status_code in (401, 403)


def test_an_empty_transcript_exports_an_empty_file_not_an_error():
    """No text yet is a valid state, not a failure."""
    user = UserFactory()
    record = audio_note(user=user)
    response = client_for(user).get(url(record, "srt"))
    assert response.status_code == 200
    assert body(response) == ""


def test_online_utterances_are_rebased_onto_the_record_clock():
    """The export must agree with the reader, which shows record-clock times."""
    user, session, transcript, record = online_note()
    # Move the utterance ten minutes after the session started.
    transcript.started_at = session.started_at + timedelta(minutes=10)
    transcript.ended_at = transcript.started_at + timedelta(seconds=2)
    transcript.save(update_fields=["started_at", "ended_at"])

    rows = transcript_export.rows_for(record)
    assert rows[0].start_ms == 600_000
    assert rows[0].end_ms == 602_000
    # And the absolute timestamp is gone: a subtitle cannot carry a wall clock.
    assert "00:10:00" in body(client_for(user).get(url(record, "srt")))


def test_capture_originals_keep_their_own_milliseconds():
    """A capture's clock already is the record's, so nothing is rebased away."""
    user = UserFactory()
    record = audio_note(user=user)
    now = record.origin_at
    capture = models.CaptureSession.objects.create(
        record=record,
        created_by=user,
        device_id="fixture",
        status="stopped",
        started_at=now,
        ended_at=now,
    )
    speaker = models.MeetingSpeaker.objects.create(
        record=record,
        capture_session=capture,
        source_track_id="track",
        source_key="0",
        label="Speaker 1",
        identity_type="diarized",
    )
    models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=capture,
        speaker=speaker,
        ingest_id=uuid.uuid4(),
        source_track_id="track",
        source_sequence=1,
        start_ms=12_345,
        end_ms=14_000,
        text="Captured line",
        payload_hash="0" * 64,
    )
    rows = transcript_export.rows_for(record)
    assert [(row.start_ms, row.end_ms) for row in rows] == [(12_345, 14_000)]
    assert "00:00:12,345" in body(client_for(user).get(url(record, "srt")))
