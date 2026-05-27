"""Auto-trigger for the meeting summary pipeline (Sprint 2.2.b).

Wired from ``core.services.livekit_events._handle_room_finished``: when
LiveKit reports a room as finished, schedule this task with a short
countdown so any in-flight FINAL transcripts have time to land in the
database. Idempotent — re-running rewrites the Summary row and replaces
its action items.

Errors are logged but never re-raised: a failed summary must not bring
down the rest of the webhook handler chain.
"""

import logging

from core.tasks._task import task

logger = logging.getLogger(__name__)


@task
def generate_meeting_summary(room_id):
    """Generate Summary + ActionItem rows for a finished meeting."""
    # Imports inline to keep this task module importable even when Celery
    # is wired up before app models are ready (e.g. during management
    # command imports).
    from core.models import Room
    from core.services.meeting_summary import MeetingSummaryService

    try:
        room = Room.objects.get(id=room_id)
    except Room.DoesNotExist:
        logger.warning(
            "Skip auto summary: room %s does not exist (deleted?)", room_id
        )
        return None

    try:
        summary = MeetingSummaryService().generate(room)
    except Exception:
        logger.exception("Auto summary failed for room %s", room_id)
        return None

    logger.info(
        "Auto summary for room %s: status=%s transcripts=%d",
        room_id,
        summary.status,
        summary.transcripts_count,
    )

    # Chain into Sprint 2.4 RAG embedding when the summary actually
    # produced useful content. Failure here is non-fatal — the room
    # already has a Summary, the AI sidebar / cross-meeting AI just
    # won't include it in retrieval until the next regen.
    if summary.status == "success" and summary.transcripts_count > 0:
        try:
            from core.tasks.embeddings import embed_meeting_transcripts

            embed_meeting_transcripts.apply_async(args=[str(room_id)])
        except Exception:
            logger.exception(
                "Failed to schedule embedding for room %s", room_id
            )

    return str(summary.id)
