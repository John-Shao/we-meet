"""Server-clock limits for temporary recording audio, independent of rollout flags."""

from datetime import timedelta

from django.utils import timezone

from core import models
from core.services.meeting_records import RecordConflict

TEMPORARY_LIFETIME = timedelta(hours=24)
RETRY_WINDOW = timedelta(minutes=30)
WORKER_DRAIN = timedelta(seconds=45)


def deadlines(capture):
    if capture.record.retention_mode != "text":
        return None, None
    hard = capture.started_at + TEMPORARY_LIFETIME
    retry = min(hard, capture.ended_at + RETRY_WINDOW) if capture.ended_at else hard
    return hard, retry


def expired(capture):
    hard, _ = deadlines(capture)
    return hard is not None and timezone.now() >= hard


def ensure_new_audio_work(capture):
    """Historical receipts remain replayable; fresh uploads/ASR must meet this gate."""
    _, retry = deadlines(capture)
    if retry is not None and timezone.now() >= retry:
        raise RecordConflict("Temporary audio retention window has closed.")


def state(capture):
    hard, retry = deadlines(capture)
    cleanup = models.CaptureAudioCleanup.objects.filter(capture=capture).first()
    return {
        "mode": capture.record.retention_mode,
        "temporary_until": hard.isoformat() if hard else None,
        "retry_until": retry.isoformat() if retry else None,
        "expired": expired(capture),
        "cleanup_status": cleanup.state if cleanup else "not_started",
        "cleanup_error": cleanup.error_code if cleanup else "",
        "deleted_at": cleanup.completed_at.isoformat()
        if cleanup and cleanup.completed_at
        else None,
    }
