"""Durable file transcription polling, separate from the HTTP upload request."""

from core.services import uploaded_recordings as service
from core.tasks._task import task


@task
def process_uploaded_recording(job_id):
    """Process one persisted provider operation."""
    service.process(job_id)


@task
def tick_uploaded_recordings():
    """Requeue due operations after worker or broker restarts."""
    for job_id in service.due():
        process_uploaded_recording.delay(str(job_id))
