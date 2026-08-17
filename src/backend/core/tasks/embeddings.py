"""Build session-scoped transcript chunks for cross-meeting retrieval."""

import logging

from django.db import transaction

from core.models import MeetingSession, Transcript, TranscriptChunk
from core.services.chunk_builder import build_chunks
from core.services.embeddings import EmbeddingClient, EmbeddingUnavailable
from core.tasks._task import task

logger = logging.getLogger(__name__)


@task
def embed_meeting_transcripts(session_id):
    """Replace chunks and embeddings for one concrete meeting session."""
    try:
        session = MeetingSession.objects.select_related("room").get(id=session_id)
    except MeetingSession.DoesNotExist:
        logger.warning(
            "Skip embedding: session %s does not exist (deleted?)", session_id
        )
        return None

    transcripts = list(
        Transcript.objects.filter(session=session).order_by("started_at")
    )
    if not transcripts:
        logger.info("Embedding skipped: session %s has no transcripts", session_id)
        TranscriptChunk.objects.filter(session=session).delete()
        return 0

    chunks = build_chunks(transcripts)
    if not chunks:
        logger.info(
            "Embedding skipped: session %s yielded no chunks after building",
            session_id,
        )
        TranscriptChunk.objects.filter(session=session).delete()
        return 0

    try:
        client = EmbeddingClient.from_settings()
    except EmbeddingUnavailable as exc:
        logger.warning("Skip embedding for session %s: %s", session_id, exc)
        return None

    try:
        vectors = client.batch_embed([chunk.text for chunk in chunks])
    except Exception:
        logger.exception(
            "Embedding API failed for session %s (%d chunks)",
            session_id,
            len(chunks),
        )
        return None

    summary = getattr(session, "summary", None)
    with transaction.atomic():
        TranscriptChunk.objects.filter(session=session).delete()
        TranscriptChunk.objects.bulk_create(
            [
                TranscriptChunk(
                    room=session.room,
                    session=session,
                    summary=summary,
                    chunk_index=chunk.chunk_index,
                    speaker_identity=chunk.speaker_identity,
                    speaker_name=chunk.speaker_name,
                    text=chunk.text,
                    started_at=chunk.started_at,
                    ended_at=chunk.ended_at,
                    source_transcript_ids=chunk.source_transcript_ids,
                    embedding=vector,
                    embedding_model=client.model,
                )
                for chunk, vector in zip(chunks, vectors, strict=True)
            ]
        )

    logger.info(
        "Embedded session %s (room %s): %d chunks via model=%s",
        session.id,
        session.room_id,
        len(chunks),
        client.model,
    )
    return len(chunks)
