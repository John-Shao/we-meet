"""Session-bound, sequenced delivery of emitted FINAL transcript events."""

import hashlib
import json
from datetime import timezone

from django.db import transaction
from django.utils import timezone as django_timezone

from core import models
from core.services.asr_observations import observation_status, validate_observation
from core.services.meeting_records import RecordConflict, ensure_online_record


def payload_hash(data):
    """Canonicalize the persisted source fields, including replay identity."""
    fields = (
        "ingest_id",
        "speaker_identity",
        "speaker_name",
        "text",
        "language",
        "started_at",
        "ended_at",
        "translations",
    )
    values = {key: data.get(key) for key in fields}
    for key in ("started_at", "ended_at"):
        if values[key] is not None:
            values[key] = values[key].astimezone(timezone.utc).isoformat()
    values["ingest_id"] = str(values["ingest_id"])
    return hashlib.sha256(
        json.dumps(values, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def row_hash(row):
    """Recheck source rows rather than trusting receipts after edits or deletion."""
    return payload_hash(
        {
            key: getattr(row, key)
            for key in (
                "ingest_id",
                "speaker_identity",
                "speaker_name",
                "text",
                "language",
                "started_at",
                "ended_at",
                "translations",
            )
        }
    )


def _lock_source(data):
    session = (
        models.MeetingSession.objects.select_for_update()
        .filter(room_id=data["room_id"], livekit_room_sid=data["livekit_room_sid"])
        .first()
    )
    if session is None:
        raise RecordConflict("An exact, existing meeting session is required.")
    record = (
        models.MeetingRecord.objects.select_for_update()
        .filter(meeting_session=session)
        .first()
    )
    if record and record.organization_id != session.room.organization_id:
        raise RecordConflict("Record provenance has changed.")
    return session, record


def _bump(record):
    if record:
        record.revision += 1
        record.save(update_fields=["revision", "updated_at"])
        record.processing_jobs.filter(
            input_revision__lt=record.revision, status__in=["queued", "running"]
        ).update(
            status="canceled",
            error_code="source_changed",
            retryable=False,
            updated_at=django_timezone.now(),
        )


@transaction.atomic
def begin_delivery(data):
    """Register a run before emitting text; retries cannot rebind its UUID."""
    session, record = _lock_source(data)
    existing = models.TranscriptDelivery.objects.filter(pk=data["delivery_id"]).first()
    if existing:
        if existing.session_id != session.pk:
            raise RecordConflict("Delivery belongs to another session.")
        return existing
    if session.status != models.MeetingSession.Status.ACTIVE:
        raise RecordConflict("New deliveries require an active session.")
    delivery = models.TranscriptDelivery.objects.create(
        id=data["delivery_id"], session=session
    )
    _bump(record)
    return delivery


@transaction.atomic
def ingest_tracked(data):
    """Persist text and sequence receipt together under the summary's record lock."""
    session, record = _lock_source(data)
    delivery = models.TranscriptDelivery.objects.filter(
        pk=data["delivery_id"], session=session
    ).first()
    if delivery is None:
        raise RecordConflict("Register this delivery for the exact session first.")
    if data["started_at"] < session.started_at or (
        data.get("ended_at") and data["ended_at"] < data["started_at"]
    ):
        raise RecordConflict("Invalid transcript interval.")
    digest = payload_hash(data)
    receipt = (
        delivery.receipts.select_related("transcript")
        .filter(sequence=data["sequence"])
        .first()
    )
    if receipt:
        row = receipt.transcript
        if (
            row is None
            or receipt.payload_hash != digest
            or row_hash(row) != digest
            or row.session_id != session.pk
            or row.room_id != session.room_id
        ):
            raise RecordConflict("Sequence was already used for another source.")
        return row, False
    if delivery.state != "open":
        raise RecordConflict("Delivery is already closed.")
    if models.Transcript.objects.filter(ingest_id=data["ingest_id"]).exists():
        raise RecordConflict("Ingest identity is already assigned.")
    values = {
        key: data.get(key)
        for key in (
            "ingest_id",
            "speaker_identity",
            "speaker_name",
            "text",
            "language",
            "started_at",
            "ended_at",
            "translations",
        )
    }
    row = models.Transcript.objects.create(
        room_id=session.room_id, session=session, **values
    )
    models.TranscriptReceipt.objects.create(
        delivery=delivery,
        transcript=row,
        sequence=data["sequence"],
        payload_hash=digest,
    )
    if record is None:
        record, _ = ensure_online_record(session)
    else:
        _bump(record)
    return row, True


def _valid_receipts(delivery):
    receipts = list(delivery.receipts.select_related("transcript").order_by("sequence"))
    valid = all(
        receipt.transcript is not None
        and receipt.transcript.session_id == delivery.session_id
        and receipt.transcript.room_id == delivery.session.room_id
        and row_hash(receipt.transcript) == receipt.payload_hash
        for receipt in receipts
    )
    contiguous = [receipt.sequence for receipt in receipts] == list(
        range(1, len(receipts) + 1)
    )
    return receipts, valid and contiguous


@transaction.atomic
def finish_delivery(data):
    """Seal only a gap-free ledger; incomplete runs never become complete later."""
    session, record = _lock_source(data)
    delivery = models.TranscriptDelivery.objects.filter(
        pk=data["delivery_id"], session=session
    ).first()
    if delivery is None:
        raise RecordConflict("Unknown delivery for this session.")
    report = validate_observation(data.get("source_report", {}))
    if delivery.state != "open":
        if (delivery.state, delivery.final_sequence) != (
            data["outcome"],
            data["final_sequence"],
        ):
            raise RecordConflict("Delivery has a different terminal manifest.")
        if delivery.source_report != report:
            raise RecordConflict("Delivery has a different source observation.")
        return delivery
    receipts, valid = _valid_receipts(delivery)
    if receipts and receipts[-1].sequence > data["final_sequence"]:
        raise RecordConflict("Final sequence precedes received events.")
    if data["outcome"] == "complete" and (
        not valid
        or len(receipts) != data["final_sequence"]
        or observation_status(report) == "incomplete"
    ):
        raise RecordConflict("Delivery has missing or changed source events.")
    if report and report["final_sentences"] < len(receipts):
        raise RecordConflict("Received text exceeds observed final sentences.")
    delivery.state = data["outcome"]
    delivery.final_sequence = data["final_sequence"]
    delivery.source_report = report
    delivery.save(
        update_fields=["state", "final_sequence", "source_report", "updated_at"]
    )
    _bump(record)
    return delivery


def source_delivery(session, rows):
    """Report transport completeness only, never infer unobserved audio coverage."""
    streams = []
    covered = set()
    incomplete = False
    for delivery in session.transcript_deliveries.order_by("id"):
        receipts, valid = _valid_receipts(delivery)
        covered.update(
            receipt.transcript_id for receipt in receipts if receipt.transcript_id
        )
        complete = (
            delivery.state == "complete"
            and valid
            and len(receipts) == delivery.final_sequence
        )
        incomplete |= not complete
        streams.append(
            {
                "id": str(delivery.pk),
                "state": delivery.state,
                "final_sequence": delivery.final_sequence,
                "received": len(receipts),
                "valid": valid,
                **(
                    {"source_report": delivery.source_report}
                    if delivery.source_report
                    else {}
                ),
            }
        )
    if not streams:
        return {}  # Keep pre-ledger snapshot fingerprints compatible.
    status = "incomplete" if incomplete else "complete"
    if covered != {row.pk for row in rows}:
        status = "unverified"
    return {"status": status, "streams": streams}
