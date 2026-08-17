"""Generate session-scoped meeting summaries after LiveKit room completion."""

import logging

from django.db import transaction

from core.models import MeetingSession, Summary, Transcript
from core.services.meeting_summary import MeetingSummaryService
from core.tasks._task import task
from core.tasks.embeddings import embed_meeting_transcripts

logger = logging.getLogger(__name__)

_HUMAN_PARTICIPANT_KINDS = ("standard", "sip")


@task
def generate_meeting_summary(session_id, force=False):
    """Generate artifacts for one meeting session.

    Automatic calls are idempotent and skip sessions without a transcript from
    a known human participant. Manual regeneration sets ``force=True`` and lets
    the service persist a failed outcome when no transcript is available.
    """
    try:
        with transaction.atomic():
            session = (
                MeetingSession.objects.select_for_update()
                .select_related("room")
                .get(id=session_id)
            )

            if not force:
                if session.status != MeetingSession.Status.ENDED:
                    logger.info(
                        "Auto summary skipped for active session %s (room %s)",
                        session.id,
                        session.room_id,
                    )
                    return None
                existing = Summary.objects.filter(
                    session=session,
                    status=Summary.Status.SUCCESS,
                ).first()
                if existing is not None:
                    logger.info(
                        "Auto summary already complete for session %s (room %s)",
                        session.id,
                        session.room_id,
                    )
                    return str(existing.id)

                human_identities = session.participations.filter(
                    kind__in=_HUMAN_PARTICIPANT_KINDS
                ).values("identity")
                has_human_transcript = Transcript.objects.filter(
                    session=session,
                    speaker_identity__in=human_identities,
                ).exists()
                if not has_human_transcript:
                    logger.info(
                        "Auto summary skipped for session %s (room %s): "
                        "no human transcript",
                        session.id,
                        session.room_id,
                    )
                    return None

            summary = MeetingSummaryService().generate(session)
    except MeetingSession.DoesNotExist:
        logger.warning(
            "Skip auto summary: session %s does not exist (deleted?)", session_id
        )
        return None
    except Exception:
        logger.exception("Auto summary failed for session %s", session_id)
        return None

    logger.info(
        "Auto summary for session %s (room %s): status=%s transcripts=%d",
        session.id,
        session.room_id,
        summary.status,
        summary.transcripts_count,
    )

    if summary.status == Summary.Status.SUCCESS and summary.transcripts_count > 0:
        try:
            embed_meeting_transcripts.apply_async(args=[str(session.id)])
        except Exception:
            logger.exception("Failed to schedule embedding for session %s", session.id)

    return str(summary.id)
