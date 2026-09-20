"""Literal whole-record replacement using the existing append-only projection."""

import hashlib
import json

from django.db import transaction
from django.utils import timezone

from core import models
from core.services.effective_transcripts import originals
from core.services.meeting_records import RecordConflict
from core.services.transcript_corrections import MAX_CORRECTION_CHARS, _authorize

MAX_SEGMENTS = 100
MAX_PREVIEW_CHARS = 400_000


def digest(value):
    """Bind confirmation to the exact current generation and corrected text."""
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def preview(record, user, find, replacement):
    """Return every changed segment or reject; never silently limit the changes."""
    _authorize(record, user)
    if (
        not isinstance(find, str)
        or not isinstance(replacement, str)
        or not find.strip()
        or len(find) > 200
        or len(replacement) > 200
        or find == replacement
    ):
        raise ValueError("invalid_replacement")
    rows = list(
        originals(record)
        .filter(corrected_text__contains=find)
        .order_by("start_ms", "id")[: MAX_SEGMENTS + 1]
    )
    if len(rows) > MAX_SEGMENTS:
        raise ValueError("replacement_too_large")
    changes = []
    for row in rows:
        after = row.corrected_text.replace(find, replacement)
        if not after.strip() or len(after) > MAX_CORRECTION_CHARS:
            raise ValueError("invalid_result")
        changes.append(
            {
                "id": str(row.pk),
                "before": row.corrected_text,
                "after": after,
                "revision": row.correction_revision,
                "start_ms": row.start_ms,
                "occurrences": row.corrected_text.count(find),
            }
        )
    if (
        sum(len(row["before"]) + len(row["after"]) for row in changes)
        > MAX_PREVIEW_CHARS
    ):
        raise ValueError("replacement_too_large")
    result = {
        "record_id": str(record.pk),
        "record_revision": record.revision,
        "find": find,
        "replacement": replacement,
        "changes": changes,
        "occurrences": sum(row["occurrences"] for row in changes),
    }
    return {**result, "preview_hash": digest(result)}


def serialize(batch):
    """History has no full transcript copies; previews require editorial access."""
    return {
        "id": str(batch.pk),
        "find": batch.find,
        "replacement": batch.replacement,
        "changed_segments": len(batch.changes),
        "created_at": batch.created_at,
        "record_revision": batch.record_revision,
        "undone": batch.undone_at is not None,
    }


def append(record, user, changes, *, undo=False):
    """Caller holds the same record lock used by single-segment corrections."""
    models.MeetingOriginalRevision.objects.bulk_create(
        [
            models.MeetingOriginalRevision(
                record=record,
                original_id=row["id"],
                revision=row["revision"] + (2 if undo else 1),
                text=row["before"] if undo else row["after"],
                edited_by=user,
            )
            for row in changes
        ]
    )
    record.revision += 1
    record.save(update_fields=["revision", "updated_at"])


@transaction.atomic
def apply(record, user, *, key, find, replacement, expected_hash):  # noqa: PLR0913
    """Replay lost responses, reject changed intent, or commit the entire preview."""
    locked = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    _authorize(locked, user)
    request_hash = digest([str(user.pk), find, replacement, expected_hash])
    existing = locked.transcript_replacements.filter(key=key).first()
    if existing:
        if existing.request_hash != request_hash:
            raise RecordConflict("replacement_key_conflict")
        return existing
    proposed = preview(locked, user, find, replacement)
    if proposed["preview_hash"] != expected_hash:
        raise RecordConflict("transcript_changed")
    if not proposed["changes"]:
        raise ValueError("no_matches")
    append(locked, user, proposed["changes"])
    return models.TranscriptReplacement.objects.create(
        record=locked,
        created_by=user,
        key=key,
        request_hash=request_hash,
        find=find,
        replacement=replacement,
        changes=proposed["changes"],
        record_revision=locked.revision,
    )


@transaction.atomic
def undo(record, user, batch_id):
    """Restore pre-batch text only if every affected segment is still unchanged."""
    locked = models.MeetingRecord.objects.select_for_update().get(pk=record.pk)
    _authorize(locked, user)
    batch = locked.transcript_replacements.filter(pk=batch_id).first()
    if not batch:
        raise LookupError("No such replacement on this record.")
    if batch.undone_at:
        return batch
    current = {
        str(row.pk): row
        for row in originals(locked).filter(pk__in=[row["id"] for row in batch.changes])
    }
    for change in batch.changes:
        row = current.get(change["id"])
        if (
            row is None
            or row.correction_revision != change["revision"] + 1
            or row.corrected_text != change["after"]
        ):
            raise RecordConflict("transcript_changed")
    append(locked, user, batch.changes, undo=True)
    batch.undone_at = timezone.now()
    batch.save(update_fields=["undone_at", "updated_at"])
    return batch
