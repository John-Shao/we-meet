"""Explicitly retained capture translations, with real recording provenance."""

from django.db import transaction
from django.utils import timezone

from core import models
from core.services import translation_archives
from core.services.meeting_captures import digest
from core.services.meeting_records import RecordConflict


def create(run, capture):
    """Called in the start transaction; recording consent is independent of playback."""
    if not run.configuration["save_translations"]:
        return
    if not translation_archives.enabled():
        raise RecordConflict("Translation retention is unavailable.")
    models.MeetingTranslationArchive.objects.create(
        record=capture.record,
        source_kind="capture",
        source_id=run.pk,
        owner=run.requested_by,
        generation=run.generation,
        configuration={**run.configuration, "capture_id": str(capture.pk)},
    )


def close(run, complete, expected_segments=None):
    """A provider success alone never proves that all confirmed text was retained."""
    if not run.configuration["save_translations"]:
        return complete
    archive = (
        models.MeetingTranslationArchive.objects.select_for_update()
        .filter(
            source_id=run.pk, source_kind="capture", record_id=run.capture.record_id
        )
        .first()
    )
    if not archive:
        return False
    rows = list(
        archive.segments.order_by("sequence").values_list("sequence", flat=True)
    )
    valid = (
        complete
        and expected_segments == archive.segment_count
        and rows == list(range(1, archive.segment_count + 1))
    )
    if archive.status == "capturing":
        archive.status = "complete" if valid else "incomplete"
        archive.save(update_fields=["status", "updated_at"])
    return bool(valid and archive.status == "complete")


def _receipt(segment, run, replayed):
    return {
        "id": str(segment.pk),
        "archive_id": str(segment.archive_id),
        "run_id": str(run.pk),
        "capture_id": str(run.capture_id),
        "generation": run.generation,
        "sequence": segment.sequence,
        "payload_hash": segment.payload_hash,
        "replayed": replayed,
    }


@transaction.atomic
def append(run_id, worker_id, data):
    """Only the claimed worker may append immutable provider-final translated items."""
    from core.services import capture_translation as control  # noqa: PLC0415

    source = models.CaptureTranslationRun.objects.only("capture_id").get(pk=run_id)
    capture = control.locked_capture(source.capture_id)
    run = models.CaptureTranslationRun.objects.select_for_update().get(pk=run_id)
    control.owned(capture, run.requested_by)
    if (
        run.worker_id != worker_id
        or data["capture_id"] != capture.pk
        or data["generation"] != run.generation
        or not run.configuration["save_translations"]
    ):
        raise PermissionError
    if data["direction"] == "reverse" and run.configuration["mode"] != "push_to_talk":
        raise RecordConflict("Unsupported translation direction.")
    archive = models.MeetingTranslationArchive.objects.select_for_update().get(
        source_kind="capture",
        source_id=run.pk,
        record=capture.record,
        owner=run.requested_by,
    )
    payload = {
        name: data[name] for name in ("direction", "response_id", "item_id", "text")
    }
    payload["source_capture_id"] = str(capture.pk)
    payload["target"] = run.configuration[
        "source_language" if data["direction"] == "reverse" else "target_language"
    ]
    fingerprint = digest(payload)
    existing = archive.segments.filter(
        direction=data["direction"],
        response_id=data["response_id"],
        item_id=data["item_id"],
    ).first()
    if existing:
        if existing.payload_hash != fingerprint:
            raise RecordConflict("Translation item conflicts with an earlier receipt.")
        return _receipt(existing, run, True)
    if (
        not control.source_valid(run, capture)
        or not run.begun_at
        or run.status not in ("starting", "translating", "stopping")
        or run.deadline <= timezone.now()
        or archive.status != "capturing"
    ):
        raise RecordConflict("Translation writer lease has ended.")
    size = len(data["text"].encode("utf-8"))
    if (
        not data["text"].strip()
        or archive.segment_count >= translation_archives.MAX_SEGMENTS
        or archive.text_bytes + size > translation_archives.MAX_TEXT_BYTES
    ):
        raise RecordConflict("Translation archive limit reached.")
    segment = archive.segments.create(
        sequence=archive.segment_count + 1, payload_hash=fingerprint, **payload
    )
    archive.segment_count += 1
    archive.text_bytes += size
    archive.save(update_fields=["segment_count", "text_bytes", "updated_at"])
    return _receipt(segment, run, False)
