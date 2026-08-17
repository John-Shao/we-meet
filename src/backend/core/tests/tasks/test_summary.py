"""Session-scoped summary task gating and idempotency."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest

from core.factories import MeetingParticipationFactory, MeetingSessionFactory
from core.models import MeetingSession, Summary, Transcript
from core.tasks.summary import generate_meeting_summary

pytestmark = pytest.mark.django_db


def _ended_session():
    started_at = timezone.now() - timedelta(minutes=10)
    return MeetingSessionFactory(
        status=MeetingSession.Status.ENDED,
        started_at=started_at,
        ended_at=started_at + timedelta(minutes=5),
        end_reason=MeetingSession.EndReason.ROOM_FINISHED,
    )


def test_auto_summary_requires_ended_session_and_human_transcript():
    active = MeetingSessionFactory()
    ended = _ended_session()

    with mock.patch(
        "core.services.meeting_summary.MeetingSummaryService.generate"
    ) as generate:
        assert generate_meeting_summary(str(active.id)) is None
        assert generate_meeting_summary(str(ended.id)) is None

    generate.assert_not_called()
    assert not Summary.objects.exists()


def test_auto_summary_uses_session_and_is_idempotent():
    session = _ended_session()
    participation = MeetingParticipationFactory(
        session=session, identity="human-user", kind="standard"
    )
    Transcript.objects.create(
        room=session.room,
        session=session,
        speaker_identity=participation.identity,
        text="A final human transcript",
        started_at=session.started_at,
    )
    summary = Summary.objects.create(
        room=session.room,
        session=session,
        status=Summary.Status.SUCCESS,
        transcripts_count=1,
    )

    with mock.patch(
        "core.services.meeting_summary.MeetingSummaryService.generate"
    ) as generate:
        result = generate_meeting_summary(str(session.id))

    assert result == str(summary.id)
    generate.assert_not_called()


def test_manual_regeneration_can_record_no_transcript_outcome():
    session = _ended_session()
    failed = Summary.objects.create(
        room=session.room,
        session=session,
        status=Summary.Status.FAILED,
        error_message="No transcripts",
    )

    with mock.patch(
        "core.services.meeting_summary.MeetingSummaryService.generate",
        return_value=failed,
    ) as generate:
        result = generate_meeting_summary(str(session.id), True)

    assert result == str(failed.id)
    generate.assert_called_once_with(session)
