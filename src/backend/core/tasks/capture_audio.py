"""Temporary audio deletion runs separately from summaries and notifications."""

from core.services.capture_audio_cleanup import tick_audio_cleanup
from core.tasks._task import task


@task
def cleanup_capture_audio():
    """Resume durable deletion without invoking or retrying a provider."""
    return tick_audio_cleanup()
