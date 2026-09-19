"""Correcting a transcript, without rewriting what the recogniser produced.

The original is immutable because citations anchor to it. These tests pin that a
correction is an appended revision, that the projection resolves it, and that
correcting the source advances the record so downstream artifacts re-read it.
"""

import uuid

from django.core.exceptions import ValidationError

import pytest

from core import models
from core.factories import UserFactory
from core.services import transcript_corrections as corrections
from core.services.meeting_records import RecordConflict
from core.tests.services.test_meeting_records import audio_note, online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def capture_summary_enabled(settings):
    """Standalone owners may correct only while this path is enabled, matching
    production. Authorization itself is what two of these tests pin."""
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    yield


def captured_segment(owner=None, *, text="Hello word.", start_ms=0, end_ms=1000):
    """One capture-backed original, the only kind an edit can address."""
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
        start_ms=start_ms,
        end_ms=end_ms,
        text=text,
        payload_hash="0" * 64,
    )
    return user, record, segment


def test_a_correction_is_appended_and_the_original_is_untouched():
    user, record, segment = captured_segment()
    _, revision = corrections.correct(record, segment.pk, user, text="Hello world.")

    segment.refresh_from_db()
    assert segment.text == "Hello word."  # what the recogniser said, still there
    assert segment.revisions.count() == 1
    assert revision.text == "Hello world."
    assert revision.edited_by_id == user.pk
    assert corrections.corrected_text(segment) == "Hello world."


def test_the_reader_sees_the_latest_correction():
    user, record, segment = captured_segment()
    corrections.correct(record, segment.pk, user, text="first fix")
    corrections.correct(record, segment.pk, user, text="second fix")
    segment.refresh_from_db()
    assert corrections.corrected_text(segment) == "second fix"
    assert segment.revisions.count() == 2


def test_correcting_advances_the_record_so_downstream_re_reads_it():
    """Summary, RAG and export are keyed on the record revision."""
    user, record, segment = captured_segment()
    before = record.revision
    corrections.correct(record, segment.pk, user, text="fixed")
    record.refresh_from_db()
    assert record.revision == before + 1


def test_resubmitting_the_same_text_is_a_noop():
    """A retried request must not inflate the revision log or bump the record."""
    user, record, segment = captured_segment()
    corrections.correct(record, segment.pk, user, text="fixed")
    record.refresh_from_db()
    after_first = record.revision

    _, revision = corrections.correct(record, segment.pk, user, text="fixed")
    record.refresh_from_db()
    assert revision is None
    assert segment.revisions.count() == 1
    assert record.revision == after_first


def test_whitespace_only_or_oversized_text_is_refused():
    user, record, segment = captured_segment()
    for bad in ("", "   ", "\n\t ", "x" * (corrections.MAX_CORRECTION_CHARS + 1)):
        with pytest.raises(ValueError):
            corrections.correct(record, segment.pk, user, text=bad)
    assert segment.revisions.count() == 0


def test_text_is_stored_trimmed():
    user, record, segment = captured_segment()
    _, revision = corrections.correct(record, segment.pk, user, text="  spaced  ")
    assert revision.text == "spaced"


def test_a_stale_editor_is_rejected_rather_than_overwriting():
    """Two editors looking at different text must not silently clobber each other."""
    user, record, segment = captured_segment()
    _, first = corrections.correct(record, segment.pk, user, text="mine")
    assert first.revision == 1

    someone_else = UserFactory()
    record.owner = someone_else
    record.save(update_fields=["owner"])
    with pytest.raises(RecordConflict):
        corrections.correct(
            record, segment.pk, someone_else, text="theirs", expected_revision=0
        )


def test_a_reader_who_may_only_read_cannot_correct():
    _, record, segment = captured_segment()
    with pytest.raises(PermissionError):
        corrections.correct(record, segment.pk, UserFactory(), text="not allowed")
    assert segment.revisions.count() == 0


def test_an_inactive_account_cannot_correct():
    user, record, segment = captured_segment()
    user.is_active = False
    user.save(update_fields=["is_active"])
    with pytest.raises(PermissionError):
        corrections.correct(record, segment.pk, user, text="nope")


def test_a_segment_from_another_record_is_not_addressable():
    user, record, segment = captured_segment()
    _, other_record, _ = captured_segment(owner=user)
    with pytest.raises(LookupError):
        corrections.correct(other_record, segment.pk, user, text="cross record")


def test_reverting_restores_what_the_recogniser_said():
    user, record, segment = captured_segment()
    corrections.correct(record, segment.pk, user, text="fixed")
    record.refresh_from_db()
    after_correction = record.revision

    original, restored = corrections.revert(record, segment.pk, user)
    record.refresh_from_db()
    assert restored.revision == 2
    assert original.revisions.count() == 2
    assert corrections.corrected_text(original) == "Hello word."
    assert record.revision == after_correction + 1


def test_reverting_with_nothing_to_revert_does_not_advance_the_record():
    user, record, segment = captured_segment()
    before = record.revision
    _, restored = corrections.revert(record, segment.pk, user)
    record.refresh_from_db()
    assert restored is None
    assert record.revision == before


def test_revisions_are_immutable_once_written():
    """An edit history that can be rewritten is not a history."""
    user, record, segment = captured_segment()
    _, revision = corrections.correct(record, segment.pk, user, text="fixed")
    revision.text = "tampered"
    with pytest.raises(ValidationError):
        revision.save()
    revision.refresh_from_db()
    assert revision.text == "fixed"


def test_this_path_only_addresses_capture_originals():
    """A meeting transcript has no revision model yet, so it must refuse cleanly.

    Half-working here would be worse than not supporting it: a correction that
    appeared to succeed but never reached the reader is undetectable.
    """
    user, _, _, record = online_note()
    with pytest.raises(LookupError):
        corrections.correct(record, uuid.uuid4(), user, text="nothing to fix")


def test_the_subquery_matches_the_python_projection():
    """The annotated queryset and `corrected_text` must not diverge."""
    user, record, segment = captured_segment()
    corrections.correct(record, segment.pk, user, text="from revision")

    annotated = (
        models.MeetingOriginalSegment.objects.filter(pk=segment.pk)
        .annotate(fixed=corrections.corrected_text_subquery())
        .get()
    )
    assert annotated.fixed == corrections.corrected_text(segment) == "from revision"

    # And it falls back to the original when no revision exists.
    _, _, untouched = captured_segment(owner=user)
    fallback = (
        models.MeetingOriginalSegment.objects.filter(pk=untouched.pk)
        .annotate(fixed=corrections.corrected_text_subquery())
        .get()
    )
    assert fallback.fixed == untouched.text


def test_a_second_segment_is_unaffected_by_a_first_correction():
    user, record, segment = captured_segment()
    other = models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=segment.capture_session,
        speaker=segment.speaker,
        ingest_id=uuid.uuid4(),
        source_track_id="track",
        source_sequence=2,
        start_ms=1000,
        end_ms=2000,
        text="second original",
        payload_hash="1" * 64,
    )
    corrections.correct(record, segment.pk, user, text="fixed first")
    other.refresh_from_db()
    assert corrections.corrected_text(other) == "second original"
    assert other.start_ms == 1000 and other.end_ms == 2000
