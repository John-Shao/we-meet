"""Celery task to embed a meeting's transcripts into TranscriptChunks
(Sprint 2.4).

Chained after ``generate_meeting_summary`` on success: by the time we
fire here the FINAL transcripts have all landed and the Summary row is
stable. Re-running on the same room is idempotent — we delete the room's
existing chunks before inserting a fresh set, so a Summary regeneration
naturally refreshes the embeddings too.

Errors are logged and swallowed: a failed embedding must not poison the
rest of the chain (e.g. block subsequent regeneration attempts). The
Personal AI service degrades gracefully when a room has no chunks.
"""

import logging

from django.db import transaction

from core.tasks._task import task

logger = logging.getLogger(__name__)


@task
def embed_meeting_transcripts(room_id):
    """Build chunks + embeddings for one finished meeting."""
    from core.models import Room, Transcript, TranscriptChunk
    from core.services.chunk_builder import build_chunks
    from core.services.embeddings import EmbeddingClient, EmbeddingUnavailable

    try:
        room = Room.objects.get(id=room_id)
    except Room.DoesNotExist:
        logger.warning(
            "Skip embedding: room %s does not exist (deleted?)", room_id
        )
        return None

    transcripts = list(
        Transcript.objects.filter(room=room).order_by("started_at")
    )
    if not transcripts:
        logger.info("Embedding skipped: room %s has no transcripts", room_id)
        # Still clear stale chunks (e.g. transcripts were deleted later).
        TranscriptChunk.objects.filter(room=room).delete()
        return 0

    chunks = build_chunks(transcripts)
    if not chunks:
        logger.info(
            "Embedding skipped: room %s yielded no chunks after building", room_id
        )
        TranscriptChunk.objects.filter(room=room).delete()
        return 0

    try:
        client = EmbeddingClient.from_settings()
    except EmbeddingUnavailable as exc:
        logger.warning(
            "Skip embedding for room %s: %s", room_id, exc
        )
        return None

    texts = [c.text for c in chunks]
    try:
        vectors = client.batch_embed(texts)
    except Exception:
        logger.exception(
            "Embedding API failed for room %s (%d chunks)", room_id, len(chunks)
        )
        return None

    summary = getattr(room, "summary", None)
    model = client.model

    with transaction.atomic():
        # Idempotent: replace any existing chunks for this room so a
        # Summary regeneration also refreshes the embeddings.
        TranscriptChunk.objects.filter(room=room).delete()
        TranscriptChunk.objects.bulk_create(
            [
                TranscriptChunk(
                    room=room,
                    summary=summary,
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
                for chunk, vector in zip(chunks, vectors)
            ]
        )

    logger.info(
        "Embedded room %s: %d chunks via model=%s",
        room_id,
        len(chunks),
        model,
    )
    return len(chunks)
