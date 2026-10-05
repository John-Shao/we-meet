"""Optimistic publication of a session index across slow embedding calls."""

import hashlib
import json
from dataclasses import dataclass

from django.db import transaction

from core import models


class StaleIndex(Exception):
    """The source, lifecycle or published index changed during provider work."""


@dataclass
class Snapshot:
    """Only one matching source/index version may publish its computed vectors."""

    session: models.MeetingSession
    summary: models.Summary | None
    authority: tuple
    transcript_hash: str
    index_ids: tuple
    transcripts: list


def _context(session_id):
    session = (
        models.MeetingSession.objects.select_for_update()
        .select_related("room")
        .filter(pk=session_id)
        .first()
    )
    if session is None:
        raise StaleIndex
    record = (
        models.MeetingRecord.objects.select_for_update()
        .filter(source_session_id=session.pk)
        .first()
    )
    if record and (
        record.deleted_at
        or record.meeting_session_id != session.pk
        or record.organization_id != session.room.organization_id
        or models.MeetingRecordPurge.objects.filter(record_uuid=record.pk).exists()
    ):
        raise StaleIndex
    summary = models.Summary.objects.select_for_update().filter(session=session).first()
    if summary and summary.room_id != session.room_id:
        raise StaleIndex
    authority = (
        session.room_id,
        session.room.organization_id,
        (record.pk, record.revision, record.lifecycle_revision) if record else None,
        (summary.pk, summary.content_generated_at) if summary else None,
    )
    return session, summary, authority


def _transcripts(session):
    rows = list(
        models.Transcript.objects.select_for_update()
        .filter(session=session)
        .order_by("started_at", "pk")
    )
    if any(row.room_id != session.room_id for row in rows):
        raise StaleIndex
    return rows


def _digest(transcripts):
    # Read actual values, not updated_at: ingestion and repairs can use update().
    fields = (
        "pk",
        "room_id",
        "session_id",
        "speaker_identity",
        "speaker_name",
        "text",
        "started_at",
        "ended_at",
    )
    data = [[getattr(row, field) for field in fields] for row in transcripts]
    return hashlib.sha256(
        json.dumps(data, default=str, separators=(",", ":")).encode()
    ).hexdigest()


def _index_ids(session):
    return tuple(
        models.TranscriptChunk.objects.filter(session=session)
        .order_by("pk")
        .values_list("pk", flat=True)
    )


@transaction.atomic(durable=True)
def capture(session_id):
    """Commit the read snapshot before provider work; never nest in caller locks."""
    session, summary, authority = _context(session_id)
    transcripts = _transcripts(session)
    return Snapshot(
        session,
        summary,
        authority,
        _digest(transcripts),
        _index_ids(session),
        transcripts,
    )


def _check(snapshot):
    session, _, authority = _context(snapshot.session.pk)
    if authority != snapshot.authority or _index_ids(session) != snapshot.index_ids:
        raise StaleIndex
    return session


@transaction.atomic
def check(snapshot):
    """Stop subsequent paid calls after deletion or another worker publishes."""
    _check(snapshot)


@transaction.atomic
def publish(snapshot, chunks, vectors, model):
    """Compare under short locks, then replace all chunks atomically."""
    session = _check(snapshot)
    if _digest(_transcripts(session)) != snapshot.transcript_hash:
        raise StaleIndex
    models.TranscriptChunk.objects.filter(session=session).delete()
    models.TranscriptChunk.objects.bulk_create(
        [
            models.TranscriptChunk(
                room=session.room,
                session=session,
                summary=snapshot.summary,
                chunk_index=chunk.chunk_index,
                speaker_identity=chunk.speaker_identity,
                speaker_name=chunk.speaker_name,
                text=chunk.text,
                started_at=chunk.started_at,
                ended_at=chunk.ended_at,
                source_transcript_ids=chunk.source_transcript_ids,
                embedding=vector,
                embedding_model=model,
            )
            for chunk, vector in zip(chunks, vectors, strict=True)
        ]
    )
