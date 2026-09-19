"""Speaker enumeration and the `speaker` filter on both original-text reads."""

import uuid
from datetime import timedelta

import pytest

from core import models
from core.factories import UserFactory
from core.tests.services.test_meeting_records import (
    audio_note,
    client_for,
    online_note,
)

pytestmark = pytest.mark.django_db
PATH = "/api/v1.0/meeting-records/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True


def add_transcript(  # noqa: PLR0913 - a fixture builder reads better with named rows
    room, session, *, identity, name, text, at
):
    return models.Transcript.objects.create(
        room=room,
        session=session,
        speaker_identity=identity,
        speaker_name=name,
        text=text,
        started_at=at,
    )


def online_with_two_speakers():
    """One online meeting whose transcript carries two distinct identities."""
    owner, session, first, record = online_note(text="opening remarks")
    second = add_transcript(
        session.room,
        session,
        identity="participant-two",
        name="Second Speaker",
        text="closing remarks",
        at=first.started_at + timedelta(minutes=1),
    )
    return owner, record, first, second


def test_speakers_lists_each_online_identity_once_with_its_row_count():
    owner, record, _, _ = online_with_two_speakers()
    body = client_for(owner).get(f"{PATH}{record.pk}/speakers/").json()
    by_id = {row["id"]: row for row in body["results"]}
    assert set(by_id) == {str(owner.pk), "participant-two"}
    assert by_id["participant-two"]["label"] == "Second Speaker"
    assert by_id["participant-two"]["rows"] == 1
    # The token to echo back is named, so a caller cannot guess the wrong param.
    assert all(row["param"] == "speaker" for row in body["results"])


def test_speaker_filter_narrows_online_transcripts_to_one_person():
    owner, record, _, _ = online_with_two_speakers()
    client = client_for(owner)
    body = client.get(f"{PATH}{record.pk}/transcripts/?speaker=participant-two").json()
    assert [row["text"] for row in body["results"]] == ["closing remarks"]
    # The identity is echoed on the row, so the UI can keep its selection.
    assert body["results"][0]["identity"] == "participant-two"


def test_unknown_speaker_yields_nothing_rather_than_the_whole_transcript():
    owner, record, _, _ = online_with_two_speakers()
    body = (
        client_for(owner)
        .get(f"{PATH}{record.pk}/transcripts/?speaker=does-not-exist")
        .json()
    )
    assert body["results"] == []


def test_empty_speaker_token_is_rejected_instead_of_ignored():
    owner, record, _, _ = online_with_two_speakers()
    response = client_for(owner).get(f"{PATH}{record.pk}/transcripts/?speaker=")
    assert response.status_code == 400


def test_speaker_filter_composes_with_full_text_search():
    owner, record, _, _ = online_with_two_speakers()
    client = client_for(owner)
    both = client.get(
        f"{PATH}{record.pk}/transcripts/?speaker=participant-two&q=closing"
    ).json()
    assert [row["text"] for row in both["results"]] == ["closing remarks"]
    # Same speaker, a term only the other person said: no rows, not a fallback.
    none = client.get(
        f"{PATH}{record.pk}/transcripts/?speaker=participant-two&q=opening"
    ).json()
    assert none["results"] == []


def test_speaker_filter_requires_transcript_access():
    """A summary-only grant must not become a way to read the transcript."""
    owner, record, _, _ = online_with_two_speakers()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    client = client_for(reader)
    assert client.get(f"{PATH}{record.pk}/speakers/").status_code == 403
    assert (
        client.get(
            f"{PATH}{record.pk}/transcripts/?speaker=participant-two"
        ).status_code
        == 403
    )


def capture_with_speakers(record):
    """Two diarized speakers with one published original segment each.

    No transcription job is attached: `current_originals` treats a null job as
    already published, which keeps this test about speaker reads rather than
    about the ASR lifecycle.
    """
    session = models.CaptureSession.objects.create(
        record=record,
        created_by=record.owner,
        device_id="device",
        started_at=record.origin_at,
        status="stopped",
        ended_at=record.origin_at + timedelta(seconds=30),
    )
    speakers = []
    for index, label in enumerate(("Speaker A", "Speaker B"), start=1):
        speaker = models.MeetingSpeaker.objects.create(
            record=record,
            capture_session=session,
            source_track_id=f"track-{index}",
            source_key=f"key-{index}",
            label=label,
            identity_type="diarized",
        )
        speakers.append(speaker)
        models.MeetingOriginalSegment.objects.create(
            record=record,
            capture_session=session,
            speaker=speaker,
            ingest_id=uuid.uuid4(),
            source_track_id=f"track-{index}",
            source_sequence=index,
            start_ms=(index - 1) * 1000,
            end_ms=index * 1000,
            text=f"segment {index}",
            payload_hash="a" * 64,
        )
    return session, speakers


def test_capture_speakers_are_listed_and_filter_by_their_uuid():
    record = audio_note()
    _, speakers = capture_with_speakers(record)
    client = client_for(record.owner)

    listed = client.get(f"{PATH}{record.pk}/speakers/").json()["results"]
    assert {row["label"] for row in listed} == {"Speaker A", "Speaker B"}
    target = next(row for row in listed if row["label"] == "Speaker B")

    body = client.get(
        f"{PATH}{record.pk}/original-segments/?speaker={target['id']}"
    ).json()
    assert [row["text"] for row in body["results"]] == ["segment 2"]


def test_capture_speaker_filter_also_accepts_the_source_key():
    """A caller that kept only the raw track key still gets a bounded subset."""
    record = audio_note()
    _, speakers = capture_with_speakers(record)
    body = (
        client_for(record.owner)
        .get(f"{PATH}{record.pk}/original-segments/?speaker=key-1")
        .json()
    )
    assert [row["text"] for row in body["results"]] == ["segment 1"]


def test_capture_speaker_filter_rejects_a_non_uuid_with_no_match():
    record = audio_note()
    capture_with_speakers(record)
    body = (
        client_for(record.owner)
        .get(f"{PATH}{record.pk}/original-segments/?speaker=not-a-key")
        .json()
    )
    assert body["results"] == []


def test_speaker_filter_is_ignored_when_absent():
    owner, record, _, _ = online_with_two_speakers()
    body = client_for(owner).get(f"{PATH}{record.pk}/transcripts/").json()
    assert len(body["results"]) == 2
