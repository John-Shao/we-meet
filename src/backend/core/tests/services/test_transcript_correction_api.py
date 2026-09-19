"""Correcting a transcript segment over HTTP, and what a reader then sees."""

import uuid

import pytest

from core import models
from core.factories import UserFactory
from core.tests.services.test_meeting_records import audio_note, client_for

pytestmark = pytest.mark.django_db

# The empty string is the detail route; the action takes a segment id.
LIST = "/api/v1.0/meeting-records/{}/original-segments/"
ONE = "/api/v1.0/meeting-records/{}/original-segments/{}/"


@pytest.fixture(autouse=True)
def capture_path_enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    yield


def captured(owner=None, *, text="Hello word."):
    """One capture-backed record with a single transcript segment."""
    user = owner or UserFactory()
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
    segment = models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=capture,
        speaker=speaker,
        ingest_id=uuid.uuid4(),
        source_track_id="track",
        source_sequence=1,
        start_ms=0,
        end_ms=1000,
        text=text,
        payload_hash="0" * 64,
    )
    return user, record, segment


def rows(user, record):
    response = client_for(user).get(LIST.format(record.id))
    assert response.status_code == 200, response.data
    return response.data["results"]


def test_a_correction_is_what_a_reader_then_sees():
    user, record, segment = captured()
    response = client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "Hello world.", "expected_revision": 0},
        format="json",
    )
    assert response.status_code == 200, response.data
    assert response.data["text"] == "Hello world."
    assert response.data["is_corrected"] is True
    assert response.data["revision"] == 1

    row = rows(user, record)[0]
    assert row["text"] == "Hello world."
    # The recogniser's own words travel with it, so an edit never looks original.
    assert row["original_text"] == "Hello word."
    assert row["is_corrected"] is True


def test_an_uncorrected_segment_reports_itself_as_uncorrected():
    user, record, segment = captured()
    row = rows(user, record)[0]
    assert row["text"] == "Hello word."
    assert row["original_text"] == "Hello word."
    assert row["is_corrected"] is False


def test_the_stored_original_is_never_rewritten():
    """Citations anchor to this row; an edit must not move what they point at."""
    user, record, segment = captured()
    client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "fixed", "expected_revision": 0},
        format="json",
    )
    segment.refresh_from_db()
    assert segment.text == "Hello word."


def test_deleting_restores_what_the_recogniser_produced():
    user, record, segment = captured()
    client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "fixed", "expected_revision": 0},
        format="json",
    )
    response = client_for(user).delete(
        ONE.format(record.id, segment.pk) + "?expected_revision=1"
    )
    assert response.status_code == 200
    assert response.data["text"] == "Hello word."
    assert response.data["is_corrected"] is False
    assert rows(user, record)[0]["text"] == "Hello word."


def test_a_stale_editor_gets_a_conflict_not_a_silent_overwrite():
    user, record, segment = captured()
    client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "mine", "expected_revision": 0},
        format="json",
    )
    response = client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "theirs", "expected_revision": 0},
        format="json",
    )
    assert response.status_code == 409
    assert response.data["code"] == "transcript_changed"


def test_resubmitting_the_same_text_reports_no_new_revision():
    user, record, segment = captured()
    client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "fixed", "expected_revision": 0},
        format="json",
    )
    response = client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "fixed", "expected_revision": 1},
        format="json",
    )
    assert response.status_code == 200
    # The retry case, not a failure: nothing changed, so nothing was appended.
    assert response.data["revision"] is None
    assert models.MeetingOriginalRevision.objects.count() == 1


def test_a_reader_who_may_only_read_cannot_correct():
    _, record, segment = captured()
    response = client_for(UserFactory()).patch(
        ONE.format(record.id, segment.pk),
        {"text": "nope", "expected_revision": 0},
        format="json",
    )
    assert response.status_code in (403, 404)
    assert models.MeetingOriginalRevision.objects.count() == 0


def test_blank_and_oversized_text_are_refused():
    user, record, segment = captured()
    for bad in ("", "   ", "x" * 20_001):
        response = client_for(user).patch(
            ONE.format(record.id, segment.pk),
            {"text": bad, "expected_revision": 0},
            format="json",
        )
        assert response.status_code == 400, bad
    assert models.MeetingOriginalRevision.objects.count() == 0


def test_an_unknown_field_is_rejected_rather_than_ignored():
    user, record, segment = captured()
    response = client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "fixed", "expected_revision": 0, "surprise": 1},
        format="json",
    )
    assert response.status_code == 400


def test_a_segment_on_another_record_is_not_found():
    user, record, segment = captured()
    _, other, _ = captured(owner=user)
    response = client_for(user).patch(
        ONE.format(other.id, segment.pk),
        {"text": "cross", "expected_revision": 0},
        format="json",
    )
    assert response.status_code == 404


def test_correcting_advances_the_revision_the_reader_was_told():
    """A reader holding expected_revision is told to refresh, not silently served."""
    user, record, segment = captured()
    before = rows(user, record)
    revision_before = client_for(user).get(
        f"{LIST.format(record.id)}?expected_revision={record.revision}"
    )
    assert revision_before.status_code == 200

    client_for(user).patch(
        ONE.format(record.id, segment.pk),
        {"text": "fixed", "expected_revision": 0},
        format="json",
    )
    stale = client_for(user).get(
        f"{LIST.format(record.id)}?expected_revision={record.revision}"
    )
    assert stale.status_code == 409
    # And an unpinned read still works, so a reader is never stuck.
    assert rows(user, record)[0]["text"] == "fixed"
    assert before[0]["start_ms"] == rows(user, record)[0]["start_ms"]


@pytest.mark.parametrize("method", ["patch", "delete"])
def test_unguarded_writes_are_refused(method):
    user, record, segment = captured()
    response = getattr(client_for(user), method)(
        ONE.format(record.id, segment.pk), {"text": "unsafe overwrite"}, format="json"
    )
    assert response.status_code == 400
    assert not segment.revisions.exists()
