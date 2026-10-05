"""Build session-scoped indexes without publishing provider-time stale results."""

import logging
import math

from core.services import transcript_index
from core.services.chunk_builder import build_chunks
from core.services.embeddings import EmbeddingClient, EmbeddingUnavailable
from core.tasks._task import task

logger = logging.getLogger(__name__)


def _validate_vectors(vectors, count):
    if not isinstance(vectors, list) or len(vectors) != count:
        raise ValueError("Embedding response count does not match chunks")
    dimension = None
    for vector in vectors:
        if not isinstance(vector, list) or not vector:
            raise ValueError("Embedding response has an empty or invalid vector")
        dimension = dimension or len(vector)
        if len(vector) != dimension or any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            for value in vector
        ):
            raise ValueError(
                "Embedding response has inconsistent dimensions or invalid values"
            )


@task
def embed_meeting_transcripts(session_id):
    """Publish only if the input, record lifecycle and previous index still match."""
    try:
        snapshot = transcript_index.capture(session_id)
        chunks = build_chunks(snapshot.transcripts)
        if not chunks:
            transcript_index.publish(snapshot, [], [], "")
            return 0
        try:
            client = EmbeddingClient.from_settings()
            vectors = client.batch_embed(
                [chunk.text for chunk in chunks],
                before_request=lambda: transcript_index.check(snapshot),
            )
            _validate_vectors(vectors, len(chunks))
        except transcript_index.StaleIndex:
            raise
        except (EmbeddingUnavailable, ValueError):
            logger.warning(
                "Embedding unavailable or invalid for session %s", session_id
            )
            return None
        except Exception:
            logger.exception("Embedding provider failed for session %s", session_id)
            return None
        transcript_index.publish(snapshot, chunks, vectors, client.model)
    except transcript_index.StaleIndex:
        logger.info("Discarded stale embedding work for session %s", session_id)
        return None
    logger.info(
        "Embedded session %s: %d chunks via model=%s",
        session_id,
        len(chunks),
        client.model,
    )
    return len(chunks)
