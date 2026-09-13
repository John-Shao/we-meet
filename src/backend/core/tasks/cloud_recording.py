"""Cloud recording commands use a durable claim independent of queue redelivery."""

from core.services.cloud_recording_worker import process, tick
from core.tasks._task import task


@task
def process_cloud_recording(command_id):
    """Execute once, or reconcile the original worker without another start."""
    process(command_id)


@task
def tick_cloud_recordings():
    """Recover queued requests and inspect expired leases, including after rollout off."""
    return tick()
