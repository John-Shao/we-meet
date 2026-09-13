"""Confirmed translations are separate retained material with current record ACLs."""

import hashlib
import json
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models.signals import post_delete
from django.utils import timezone

from core import models
from core.services.meeting_records import RecordConflict, ensure_online_record
from core.services.online_capture import can_control

MAX_SEGMENTS = 20000
MAX_TEXT_BYTES = 8 * 1024 * 1024


def enabled():
    """Do not create retained material before its record reader can be deployed."""
    return (
        settings.MEETING_TRANSLATION_ARCHIVE_ENABLED
        and settings.MEETING_RECORDS_ENABLED
    )


def prepare_record(session, save):
    """A manager's explicit channel start freezes one exact note identity."""
    if type(save) is not bool:
        raise RecordConflict("Invalid translation retention choice.")
    if not save:
        return None
    if not enabled():
        raise RecordConflict("Translation retention is unavailable.")
    return ensure_online_record(session, allow_empty=True)[0]


def create_archive(channel, record, *, source_kind="channel"):
    """Keep an archive after the live channel/session has been deleted."""
    if record is not None:
        models.MeetingTranslationArchive.objects.create(
            record=record,
            source_kind=source_kind,
            source_id=channel.pk,
            owner=channel.requested_by,
            generation=channel.generation,
            configuration=channel.configuration,
        )


def close_archive(channel, completed, *, source_kind="channel"):
    """A live-channel success alone cannot claim successful durable delivery."""
    models.MeetingTranslationArchive.objects.filter(
        source_id=channel.pk, source_kind=source_kind, status="capturing"
    ).update(
        status="complete" if completed else "incomplete", updated_at=timezone.now()
    )


def _channel_deleted(sender, instance, **kwargs):
    close_archive(instance, False)


def _private_deleted(sender, instance, **kwargs):
    close_archive(instance, False, source_kind="private")


def _capture_deleted(sender, instance, **kwargs):
    close_archive(instance, False, source_kind="capture")


def _capture_segment_deleted(sender, instance, **kwargs):
    models.MeetingTranslationArchive.objects.filter(
        pk=instance.archive_id, source_kind="capture"
    ).update(status="incomplete", updated_at=timezone.now())


def connect_handlers():
    """Deleting a live source cannot leave its retained archive apparently running."""
    post_delete.connect(
        _channel_deleted,
        sender=models.MeetingInterpretationChannel,
        dispatch_uid="meeting_translation_archive_channel_deleted",
    )
    post_delete.connect(
        _private_deleted,
        sender=models.MeetingTranslationRun,
        dispatch_uid="meeting_translation_archive_private_deleted",
    )
    post_delete.connect(
        _capture_deleted,
        sender=models.CaptureTranslationRun,
        dispatch_uid="capture_translation_source_deleted",
    )
    post_delete.connect(
        _capture_segment_deleted,
        sender=models.MeetingTranslationSegment,
        dispatch_uid="capture_translation_segment_deleted",
    )


def _validate_item(data, *, directions=("forward",)):
    text = data.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 20000:
        raise RecordConflict("Invalid confirmed translation text.")
    for field in ("response_id", "item_id"):
        value = data.get(field)
        if not isinstance(value, str) or not 0 < len(value) <= 128:
            raise RecordConflict("Invalid provider item identity.")
    if data.get("direction") not in directions:
        raise RecordConflict("Unsupported translation direction.")
    return len(text.encode("utf-8"))


def _receipt(segment, channel, record_id, *, replayed, source_kind):
    return {
        "id": str(segment.pk),
        "sequence": segment.sequence,
        "replayed": replayed,
        "run_id" if source_kind == "private" else "channel_id": str(channel.pk),
        "generation": channel.generation,
        "record_id": str(record_id),
        "payload_hash": segment.payload_hash,
    }


@transaction.atomic
def append_segment(channel_id, data, *, source_kind="channel"):
    """Retry the same confirmed item without renewing any input/output permission."""
    private = source_kind == "private"
    model = (
        models.MeetingTranslationRun if private else models.MeetingInterpretationChannel
    )
    identity = model.objects.get(pk=channel_id)
    directions = (
        ("forward", "reverse")
        if private and identity.configuration["mode"] == "push_to_talk"
        else ("forward",)
    )
    byte_count = _validate_item(data, directions=directions)
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .get(pk=identity.session_id)
    )
    channel = model.objects.get(pk=channel_id)
    if (
        str(session.room_id) != str(data["room_id"])
        or session.livekit_room_sid != data["livekit_room_sid"]
        or channel.generation != data["generation"]
        or channel.worker_id is None
        or channel.worker_id != data["worker_id"]
    ):
        raise RecordConflict("Translation writer identity changed.")
    archive = (
        models.MeetingTranslationArchive.objects.select_for_update()
        .filter(
            source_id=channel.pk,
            source_kind=source_kind,
            generation=channel.generation,
            record_id=channel.configuration.get("archive_record_id"),
            record__source_session_id=session.pk,
        )
        .first()
    )
    if archive is None:
        raise RecordConflict("No retained translation was requested.")
    payload = {
        "source_participation_id": str(data["source_participation_id"]),
        "source_participant_sid": data["source_participant_sid"],
        "response_id": data["response_id"],
        "item_id": data["item_id"],
        "direction": data["direction"],
        "text": data["text"],
        "target": channel.configuration[
            "source" if data["direction"] == "reverse" else "target"
        ]
        if private
        else channel.target,
    }
    digest = hashlib.sha256(
        json.dumps(
            payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    existing = archive.segments.filter(
        **{
            field: payload[field]
            for field in [
                "source_participation_id",
                "direction",
                "response_id",
                "item_id",
            ]
        }
    ).first()
    if existing:
        if existing.payload_hash != digest:
            raise RecordConflict("Confirmed translation item conflicts.")
        return _receipt(
            existing, channel, archive.record_id, replayed=True, source_kind=source_kind
        )
    now = timezone.now()
    if (
        not enabled()
        or not (
            settings.MEETING_TRANSLATION_ENABLED
            if private
            else settings.MEETING_INTERPRETATION_ENABLED
        )
        or channel.state not in {"translating", "stopping"}
        or archive.status != "capturing"
        or not channel.heartbeat_at
        or channel.heartbeat_at + timedelta(seconds=30 if private else 15) <= now
        or (
            channel.stop_requested_at
            and channel.stop_requested_at + timedelta(seconds=30 if private else 25)
            <= now
        )
        or session.status != "active"
        or session.room.organization_id != channel.organization_id_snapshot
        or archive.record.organization_id != session.room.organization_id
        or not models.User.objects.filter(
            pk=channel.requested_by_id, is_active=True
        ).exists()
        or not can_control(session, channel.requested_by)
    ):
        raise RecordConflict("Translation archive permission expired.")
    if private and (
        channel.source_participation_id != data["source_participation_id"]
        or archive.owner_id != channel.requested_by_id
        or channel.source_participation.user_id != channel.requested_by_id
        or channel.source_participation.left_at is not None
    ):
        raise RecordConflict("Private translation source permission expired.")
    if not session.participations.filter(
        pk=data["source_participation_id"],
        kind="standard",
        livekit_participant_sid=data["source_participant_sid"],
    ).exists():
        raise RecordConflict("Translation speaker belongs to another source.")
    if (
        archive.segment_count >= MAX_SEGMENTS
        or archive.text_bytes + byte_count > MAX_TEXT_BYTES
    ):
        raise RecordConflict("Translation archive limit reached.")
    sequence = archive.segment_count + 1
    segment = archive.segments.create(sequence=sequence, payload_hash=digest, **payload)
    archive.segment_count, archive.text_bytes = (
        sequence,
        archive.text_bytes + byte_count,
    )
    archive.save(update_fields=["segment_count", "text_bytes", "updated_at"])
    return _receipt(
        segment, channel, archive.record_id, replayed=False, source_kind=source_kind
    )
