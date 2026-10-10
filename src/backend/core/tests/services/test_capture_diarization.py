"""Real PostgreSQL source publication, historical IDs and human corrections."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event

from django.core.exceptions import ValidationError
from django.db import close_old_connections, transaction
from django.db.models import QuerySet
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import capture_diarization as service
from core.services import (
    capture_summary_source,
    effective_transcripts,
    record_lifecycle,
    speaker_identity_decisions,
    transcript_corrections,
    transcript_export,
    word_alignment,
)
from core.services.meeting_captures import CaptureDenied, digest
from core.services.meeting_records import RecordConflict
from core.services.speaker_attribution import AttributionDenied
from core.tests.services.test_capture_transcription import (
    acknowledge,
    claim,
    control,
    final,
    finish,
    request_job,
    running,
)
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.MEETING_CAPTURE_AUDIO_ENABLED = True
    settings.MEETING_CAPTURE_ASR_ENABLED = True
    settings.MEETING_CAPTURE_DIARIZATION_ENABLED = True
    settings.MEETING_CAPTURE_SUMMARY_ENABLED = True
    settings.AGENT_INTERNAL_API_TOKEN = "asr-test-only"
    settings.STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}
    }
    settings.MEDIA_ROOT = str(tmp_path)


def source(*, timed=False):
    owner, capture, worker, description = running()
    acknowledge(description, worker)
    job = models.CaptureTranscriptionJob.objects.get(pk=description["id"])
    text = "One. Two."
    payload = {
        "ingest_id": str(uuid.uuid4()),
        "sequence": 1,
        "start_ms": 0,
        "end_ms": 1000,
        "text": text,
        "language": "en",
    }
    data, status = word_alignment.from_sentence(
        {
            "text": text,
            "begin_time": 0,
            "end_time": 1000,
            "words": [
                {"text": "One", "begin_time": 100, "end_time": 400},
                {"text": "Two", "begin_time": 600, "end_time": 900},
            ],
        },
        "qwen-audio-3.1-asr-flash-filetrans",
        1000,
    )
    track = f"asr:{job.pk}"
    speaker = models.MeetingSpeaker.objects.create(
        record_id=capture.record_id,
        capture_session=capture,
        source_track_id=track,
        source_key="unknown",
        label="Unknown speaker",
        identity_type="unknown",
    )
    # Simulated provider evidence is present at initial creation, not an edit to
    # immutable originals or a caller-provided word-timing HTTP field.
    original = models.MeetingOriginalSegment.objects.create(
        record_id=capture.record_id,
        capture_session=capture,
        transcription_job=job,
        speaker=speaker,
        source_track_id=track,
        source_sequence=1,
        ingest_id=payload["ingest_id"],
        start_ms=0,
        end_ms=1000,
        text=text,
        language="en",
        payload_hash=digest(payload),
        word_alignment=data if timed else None,
        alignment_status=status if timed else "missing",
        alignment_revision=1 if timed else 0,
    )
    job.final_sequence, job.text_bytes = 1, len(text.encode())
    job.save(update_fields=["final_sequence", "text_bytes", "updated_at"])
    result = finish(job.pk, worker)
    assert result.status_code == 200, result.data
    capture.refresh_from_db()
    capture.record.refresh_from_db()
    return owner, capture, original


def prepare(owner, capture):
    capture.record.refresh_from_db()
    return service.prepare(
        capture.pk, owner, uuid.uuid4(), expected_revision=capture.record.revision
    )[0]


def process(owner, capture, *, two=False):
    job = prepare(owner, capture)
    worker = uuid.uuid4()
    assert service.claim(job.pk, worker)
    turns = (
        [
            {"start_ms": 0, "end_ms": 500, "speaker": "0"},
            {"start_ms": 500, "end_ms": 1000, "speaker": "1"},
        ]
        if two
        else [{"start_ms": 0, "end_ms": 1000, "speaker": "0"}]
    )
    return service.publish(job.pk, worker, turns), worker, turns


def originals(owner, capture, **query):
    return client_for(owner).get(
        f"/api/v1.0/meeting-records/{capture.record_id}/original-segments/", query
    )


def test_prepare_is_explicit_idempotent_and_never_replaces_the_active_asr():
    owner, capture, original = source()
    key = uuid.uuid4()
    revision = capture.record.revision
    job, created = service.prepare(capture.pk, owner, key, expected_revision=revision)
    again, duplicate = service.prepare(
        capture.pk, owner, key, expected_revision=revision
    )
    assert created and not duplicate and again.pk == job.pk
    assert job.source_transcription_id == capture.active_transcription_id
    assert originals(owner, capture).data["results"][0]["id"] == str(original.pk)
    with pytest.raises(RecordConflict):
        service.prepare(capture.pk, owner, key, expected_revision=revision + 1)
    with pytest.raises(RecordConflict):
        prepare(owner, capture)


def test_publication_switches_one_generation_without_changing_originals_or_asr():
    owner, capture, parent = source(timed=True)
    prior_asr = capture.active_transcription_id
    before_hash, before_text = parent.payload_hash, parent.text
    job, worker, turns = process(owner, capture, two=True)
    rows = originals(owner, capture).data["results"]
    assert [row["text"] for row in rows] == ["One. ", "Two."]
    assert [row["speaker_label"] for row in rows] == ["Speaker 1", "Speaker 2"]
    assert {row["parent_original_id"] for row in rows} == {str(parent.pk)}
    assert all(
        row["can_correct"] and row["speaker_mapping"]["status"] == "known"
        for row in rows
    )
    parent.refresh_from_db()
    capture.refresh_from_db()
    assert (
        parent.text == before_text
        and parent.payload_hash == before_hash
        and parent.speaker.identity_type == "unknown"
    )
    assert (
        capture.active_transcription_id == prior_asr
        and capture.active_diarization_id == job.pk
    )
    capture.record.refresh_from_db()
    revision = capture.record.revision
    assert service.publish(job.pk, worker, turns).pk == job.pk
    capture.record.refresh_from_db()
    assert capture.record.revision == revision
    assert (
        models.MeetingOriginalSegment.objects.filter(diarization_job=job).count() == 2
    )


def test_missing_word_timing_preserves_the_whole_sentence_as_ambiguous():
    owner, capture, parent = source()
    job, _, _ = process(owner, capture, two=True)
    (row,) = originals(owner, capture).data["results"]
    assert (
        row["text"] == parent.text and row["speaker_mapping"]["status"] == "ambiguous"
    )
    assert row["speaker_mapping"]["reason"] == "word_timing_unavailable"
    assert job.originals.get().speaker.identity_type == "unknown"
    with pytest.raises(AttributionDenied):
        speaker_identity_decisions.decide(
            capture.record,
            job.originals.get().speaker_id,
            owner,
            action="set_label",
            label="Must not name mixed audio",
        )


def test_history_pins_original_and_derived_generations_without_mixing_rows():
    owner, capture, parent = source(timed=True)
    first, _, _ = process(owner, capture, two=True)
    second, _, _ = process(owner, capture)
    base = originals(
        owner, capture, transcription_job_id=str(capture.active_transcription_id)
    ).data["results"]
    assert [row["id"] for row in base] == [str(parent.pk)] and not base[0][
        "can_correct"
    ]
    old = originals(owner, capture, diarization_job_id=str(first.pk)).data["results"]
    assert len(old) == 2 and all(not row["can_correct"] for row in old)
    current = originals(owner, capture).data["results"]
    assert {row["diarization_job_id"] for row in current} == {str(second.pk)}
    assert "".join(row["text"] for row in current) == parent.text
    assert models.MeetingOriginalSegment.objects.get(pk=old[0]["id"]).text == "One. "


def test_existing_human_corrections_are_inherited_without_fabricating_audit_rows():
    owner, capture, parent = source(timed=True)
    _, correction = transcript_corrections.correct(
        capture.record, parent.pk, owner, text="Human wording.", expected_revision=0
    )
    count = models.MeetingOriginalRevision.objects.count()
    job, _, _ = process(owner, capture, two=True)
    (row,) = effective_transcripts.originals(capture.record)
    assert (
        row.text == parent.text
        and row.corrected_text == "Human wording."
        and row.correction_revision == 1
    )
    assert (
        row.inherited_correction_id == correction.pk
        and models.MeetingOriginalRevision.objects.count() == count
    )
    changed, next_revision = transcript_corrections.correct(
        capture.record, row.pk, owner, text="Next wording.", expected_revision=1
    )
    assert next_revision.revision == 2 and changed.correction_revision == 2
    assert transcript_corrections.corrected_text(parent) == "Human wording."
    with pytest.raises(LookupError):
        transcript_corrections.correct(
            capture.record, parent.pk, owner, text="Stale edit."
        )
    assert job.originals.get().derivation["status"] == "ambiguous"


def test_reprocessing_keeps_derived_corrections_and_their_historical_anchors():
    owner, capture, _ = source(timed=True)
    first, _, _ = process(owner, capture, two=True)
    row = first.originals.order_by("source_sequence").first()
    _, edit = transcript_corrections.correct(
        capture.record, row.pk, owner, text="Edited first part."
    )
    second, _, _ = process(owner, capture)
    current = list(
        effective_transcripts.originals(capture.record).order_by("source_sequence")
    )
    assert (
        current[0].parent_original_id == row.pk
        and current[0].inherited_correction_id == edit.pk
    )
    assert (
        current[0].corrected_text == "Edited first part."
        and current[1].corrected_text == "Two."
    )
    assert models.MeetingOriginalSegment.objects.get(pk=row.pk).text == "One. "
    assert second.source_derivation_id == first.pk


def test_exports_and_new_summary_sources_use_the_same_current_speakers_and_text():
    owner, capture, _ = source(timed=True)
    job, _, _ = process(owner, capture, two=True)
    row = job.originals.order_by("source_sequence").first()
    speaker_identity_decisions.decide(
        capture.record, row.speaker_id, owner, action="set_label", label="Reviewer"
    )
    exported = transcript_export.rows_for(capture.record)
    capture.refresh_from_db()
    capture.record.refresh_from_db()
    summary, _ = capture_summary_source.source(capture.record)
    assert [item.speaker for item in exported] == ["Reviewer", "Speaker 2"]
    assert [item["speaker_name"] for item in summary] == ["Reviewer", "Speaker 2"]
    assert [item.text for item in exported] == [item["text"] for item in summary]
    assert [item["segment_id"] for item in summary] == [
        str(row.pk),
        str(job.originals.get(source_sequence=2).pk),
    ]


def test_a_successful_asr_retry_supersedes_derivation_but_a_queued_retry_does_not():
    owner, capture, _ = source()
    derived, _, _ = process(owner, capture)
    result = request_job(owner, capture, expected=capture.active_transcription_id)
    assert result.status_code == 201, result.data
    assert originals(owner, capture).data["results"][0]["diarization_job_id"] == str(
        derived.pk
    )
    worker, job = claim()
    assert control(job["id"], worker, "begin").status_code == 200
    acknowledge(job, worker)
    result, _ = final(job["id"], worker, text="New ASR source.")
    assert result.status_code == 201 and finish(job["id"], worker).status_code == 200
    rows = originals(owner, capture).data["results"]
    assert [row["text"] for row in rows] == ["New ASR source."] and rows[0][
        "diarization_job_id"
    ] is None


@pytest.mark.parametrize(
    "change", ["flag", "account", "audio_deleted", "cleanup", "text_edit", "chunk_key"]
)
def test_source_or_authority_changes_prevent_publication(settings, change):
    owner, capture, parent = source()
    job = prepare(owner, capture)
    worker = uuid.uuid4()
    assert service.claim(job.pk, worker)
    if change == "flag":
        settings.MEETING_CAPTURE_DIARIZATION_ENABLED = False
    elif change == "account":
        models.User.objects.filter(pk=owner.pk).update(is_active=False)
    elif change == "audio_deleted":
        capture.audio_chunks.update(audio_deleted_at=timezone.now())
    elif change == "cleanup":
        models.CaptureAudioCleanup.objects.create(
            capture=capture, next_attempt_at=timezone.now()
        )
    elif change == "text_edit":
        transcript_corrections.correct(
            capture.record, parent.pk, owner, text="New edit."
        )
    else:
        capture.audio_chunks.update(object_key="another/object.wav")
    with pytest.raises((CaptureDenied, RecordConflict)):
        service.publish(
            job.pk, worker, [{"start_ms": 0, "end_ms": 1000, "speaker": "0"}]
        )
    assert not job.originals.exists()
    capture.refresh_from_db()
    assert capture.active_diarization_id is None


def test_expired_leases_and_replaced_workers_cannot_publish_late_results():
    owner, capture, _ = source()
    job = prepare(owner, capture)
    old, new = uuid.uuid4(), uuid.uuid4()
    assert service.claim(job.pk, old)
    assert service.claim(job.pk, new) is None
    models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    assert service.claim(job.pk, new)
    turns = [{"start_ms": 0, "end_ms": 1000, "speaker": "0"}]
    with pytest.raises(RecordConflict):
        service.publish(job.pk, old, turns)
    assert service.publish(job.pk, new, turns).status == "succeeded"


def test_failure_rolls_back_all_new_rows_and_keeps_the_old_source(monkeypatch):
    owner, capture, parent = source(timed=True)
    job = prepare(owner, capture)
    worker = uuid.uuid4()
    assert service.claim(job.pk, worker)
    bulk = models.MeetingOriginalSegment.objects.bulk_create

    def partial_failure(rows, **kwargs):
        bulk(rows[:1], **kwargs)
        raise RuntimeError("Synthetic publication failure after first insert")

    monkeypatch.setattr(
        models.MeetingOriginalSegment.objects, "bulk_create", partial_failure
    )
    with pytest.raises(RuntimeError, match="Synthetic publication failure"):
        service.publish(
            job.pk,
            worker,
            [
                {"start_ms": 0, "end_ms": 500, "speaker": "0"},
                {"start_ms": 500, "end_ms": 1000, "speaker": "1"},
            ],
        )
    assert (
        not job.originals.exists()
        and not capture.record.speakers.filter(
            source_track_id=f"diarization:{job.pk}"
        ).exists()
    )
    assert list(
        effective_transcripts.originals(capture.record).values_list("pk", flat=True)
    ) == [parent.pk]


def test_expired_audio_and_disabled_feature_cannot_start_new_work(settings):
    owner, capture, _ = source()
    settings.MEETING_CAPTURE_DIARIZATION_ENABLED = False
    with pytest.raises(CaptureDenied):
        prepare(owner, capture)
    settings.MEETING_CAPTURE_DIARIZATION_ENABLED = True
    capture.record.retention_mode = "text"
    capture.record.save(update_fields=["retention_mode"])
    capture.started_at = timezone.now() - timedelta(days=1)
    capture.ended_at = timezone.now() - timedelta(hours=1)
    capture.save(update_fields=["started_at", "ended_at"])
    with pytest.raises(RecordConflict):
        prepare(owner, capture)
    assert not capture.diarization_jobs.exists()


def test_source_receipts_and_publication_are_model_immutable():
    owner, capture, _ = source()
    job, _, _ = process(owner, capture)
    job.configuration = {"other": True}
    with pytest.raises(ValidationError):
        job.clean()
    row = job.originals.get()
    with pytest.raises(ValidationError):
        row.clean()


def test_foreign_owners_and_malformed_commands_cannot_create_jobs():
    owner, capture, _ = source()
    with pytest.raises(CaptureDenied):
        prepare(UserFactory(), capture)
    with pytest.raises(ValueError):
        service.prepare(capture.pk, owner, "not-a-uuid", expected_revision=1)
    with pytest.raises(ValueError):
        service.prepare(capture.pk, owner, uuid.uuid4(), expected_revision=True)
    assert not capture.diarization_jobs.exists()


@pytest.mark.parametrize(
    "budget", ["original", "correction", "alignment", "derivation"]
)
def test_oversized_sources_are_rejected_before_creating_a_job(monkeypatch, budget):
    owner, capture, parent = source(timed=True)
    if budget == "derivation":
        monkeypatch.setattr(service, "MAX_DERIVATION_BYTES", 1)
    elif budget == "alignment":
        monkeypatch.setattr(service, "MAX_ALIGNMENT_BYTES", 1)
    else:
        monkeypatch.setattr(
            service, "MAX_TEXT_BYTES", 8 if budget == "original" else 10
        )
        if budget == "correction":
            # Four Chinese characters take twelve UTF-8 bytes.
            transcript_corrections.correct(
                capture.record, parent.pk, owner, text="人工修订"
            )
    with pytest.raises(RecordConflict, match="source exceeds its budget"):
        prepare(owner, capture)
    assert not capture.diarization_jobs.exists()


def test_history_cannot_pin_a_foreign_or_mismatched_generation():
    owner, capture, _ = source()
    derived, _, _ = process(owner, capture)
    other_owner, other_capture, _ = source()
    other, _, _ = process(other_owner, other_capture)
    assert (
        originals(owner, capture, diarization_job_id=str(other.pk)).status_code == 404
    )
    assert (
        originals(
            owner,
            capture,
            diarization_job_id=str(derived.pk),
            transcription_job_id=str(other_capture.active_transcription_id),
        ).status_code
        == 404
    )
    assert originals(owner, capture, diarization_job_id="not-a-uuid").status_code == 400
    assert (
        request_job(
            owner, capture, expected=capture.active_transcription_id
        ).status_code
        == 201
    )
    worker, new_asr = claim()
    assert control(new_asr["id"], worker, "begin").status_code == 200
    acknowledge(new_asr, worker)
    assert final(new_asr["id"], worker)[0].status_code == 201
    assert finish(new_asr["id"], worker).status_code == 200
    assert (
        originals(
            owner,
            capture,
            diarization_job_id=str(derived.pk),
            transcription_job_id=new_asr["id"],
        ).status_code
        == 404
    )


def test_inherited_correction_must_belong_to_the_same_parent_lineage():
    owner, capture, _ = source(timed=True)
    first, _, _ = process(owner, capture, two=True)
    edited = first.originals.get(source_sequence=1)
    _, correction = transcript_corrections.correct(
        capture.record, edited.pk, owner, text="Only the first part was edited."
    )
    next_job = prepare(owner, capture)
    other = first.originals.get(source_sequence=2)
    candidate = first.originals.get(source_sequence=2)
    candidate.pk, candidate._state.adding = uuid.uuid4(), True
    candidate.diarization_job = next_job
    candidate.parent_original = other
    candidate.inherited_correction = correction
    with pytest.raises(ValidationError, match="source lineage"):
        candidate.clean()


def test_pending_diarization_prevents_trash_but_an_expired_intent_does_not(settings):
    settings.MEETING_RECORD_TRASH_ENABLED = True
    owner, capture, _ = source()
    job = prepare(owner, capture)
    with pytest.raises(RecordConflict, match="Wait for capture"):
        record_lifecycle.transition(capture.record_id, owner, "trashed", 0)
    models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(
        deadline=timezone.now() - timedelta(seconds=1)
    )
    assert (
        record_lifecycle.transition(capture.record_id, owner, "trashed", 0).deleted_at
        is not None
    )
    assert service.claim(job.pk, uuid.uuid4()) is None


def test_publishing_a_replacement_cancels_old_live_and_quick_summary_jobs():
    owner, capture, _ = source()
    drafts = [
        models.MeetingProcessingJob.objects.create(
            record=capture.record,
            kind="summary",
            generation=index,
            input_revision=capture.record.revision,
            configuration={"stage": stage},
        )
        for index, stage in enumerate(["realtime", "quick", "final"], 1)
    ]
    process(owner, capture)
    for draft in drafts:
        draft.refresh_from_db()
        assert draft.status == "canceled" and draft.error_code == "source_changed"


def test_record_erasure_can_cascade_all_historical_derivative_lineage():
    owner, capture, _ = source(timed=True)
    first, _, _ = process(owner, capture, two=True)
    transcript_corrections.correct(
        capture.record, first.originals.first().pk, owner, text="Human correction."
    )
    process(owner, capture)
    capture.record.delete()
    assert not models.CaptureDiarizationJob.objects.exists()
    assert not models.MeetingOriginalRevision.objects.exists()


def test_a_missing_requester_fails_claim_without_starting_processing():
    owner, capture, _ = source()
    job = prepare(owner, capture)
    models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(requested_by=None)
    assert service.claim(job.pk, uuid.uuid4()) is None
    job.refresh_from_db()
    assert job.status == "failed" and not job.originals.exists()
    with pytest.raises(CaptureDenied):
        service.publish(
            job.pk, uuid.uuid4(), [{"start_ms": 0, "end_ms": 1000, "speaker": "0"}]
        )


@pytest.mark.django_db(transaction=True)
def test_publication_waits_for_account_deactivation_and_rechecks_it(monkeypatch):
    owner, capture, _ = source()
    job = prepare(owner, capture)
    worker = uuid.uuid4()
    assert service.claim(job.pk, worker)
    observed = Event()
    get = QuerySet.get

    def observe_job(queryset, *args, **kwargs):
        result = get(queryset, *args, **kwargs)
        if queryset.model is models.CaptureDiarizationJob:
            observed.set()
        return result

    monkeypatch.setattr(QuerySet, "get", observe_job)

    def publish_in_thread():
        close_old_connections()
        try:
            return service.publish(
                job.pk, worker, [{"start_ms": 0, "end_ms": 1000, "speaker": "0"}]
            )
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as executor:
        with transaction.atomic():
            models.User.objects.select_for_update().get(pk=owner.pk)
            future = executor.submit(publish_in_thread)
            assert observed.wait(10), "Publication identity was not read"
            models.User.objects.filter(pk=owner.pk).update(is_active=False)
        with pytest.raises(CaptureDenied):
            future.result(timeout=10)
    assert not job.originals.exists()


@pytest.mark.django_db(transaction=True)
def test_capture_is_reloaded_after_waiting_for_the_record_lock(monkeypatch):
    _, capture, _ = source()
    observed = Event()
    get = QuerySet.get

    def observe_identity(queryset, *args, **kwargs):
        result = get(queryset, *args, **kwargs)
        if queryset.model is models.CaptureSession:
            observed.set()
        return result

    monkeypatch.setattr(QuerySet, "get", observe_identity)

    def read_after_lock():
        close_old_connections()
        try:
            with transaction.atomic():
                return service._capture(capture.pk).revision
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as executor:
        with transaction.atomic():
            models.MeetingRecord.objects.select_for_update().get(pk=capture.record_id)
            future = executor.submit(read_after_lock)
            assert observed.wait(10), "Capture identity was not read"
            models.CaptureSession.objects.filter(pk=capture.pk).update(
                revision=capture.revision + 1
            )
        assert future.result(timeout=10) == capture.revision + 1


@pytest.mark.parametrize("change", ["text", "all_rows", "track"])
def test_tampering_with_derived_publication_is_rejected_by_summary_and_reprocessing(
    change,
):
    owner, capture, _ = source()
    job, _, _ = process(owner, capture)
    if change == "all_rows":
        job.originals.all().delete()
    elif change == "track":
        job.originals.update(source_track_id="another-track")
    else:
        job.originals.update(text="Tampered")
    capture.refresh_from_db()
    capture.record.refresh_from_db()
    with pytest.raises(RecordConflict):
        capture_summary_source.source(capture.record)
    with pytest.raises(RecordConflict):
        prepare(owner, capture)


@pytest.mark.django_db(transaction=True)
def test_two_concurrent_replays_publish_only_once():
    owner, capture, _ = source()
    job = prepare(owner, capture)
    worker = uuid.uuid4()
    assert service.claim(job.pk, worker)
    turns = [{"start_ms": 0, "end_ms": 1000, "speaker": "0"}]

    def replay():
        close_old_connections()
        try:
            return service.publish(job.pk, worker, turns).pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert list(executor.map(lambda _: replay(), range(2))) == [job.pk, job.pk]
    capture.refresh_from_db()
    assert capture.active_diarization_id == job.pk
    assert job.originals.count() == 1
