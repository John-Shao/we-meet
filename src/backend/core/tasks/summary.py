"""Session-scoped legacy summaries, claimed without holding provider-time locks."""

import logging

from core.models import MeetingSession, Summary
from core.services.meeting_summary import MeetingSummaryService
from core.tasks._task import task
from core.tasks.embeddings import embed_meeting_transcripts

logger = logging.getLogger(__name__)


@task
def generate_meeting_summary(session_id, force=False):
    """Automatic duplicates are free; explicit regeneration can retry a failed run."""
    try:
        session = MeetingSession.objects.select_related("room").get(pk=session_id)
        service = MeetingSummaryService()
        summary = service.generate(session, automatic=not force)
    except MeetingSession.DoesNotExist:
        logger.warning("Skip summary for deleted session %s", session_id)
        return None
    except Exception:
        logger.exception("Summary failed for session %s", session_id)
        return None
    if summary is None:
        return None
    if (
        service.generated
        and summary.status == Summary.Status.SUCCESS
        and summary.transcripts_count > 0
    ):
        try:
            embed_meeting_transcripts.apply_async(args=[str(session.id)])
        except Exception:
            logger.exception("Failed to schedule embedding for session %s", session.id)
    return str(summary.id)
