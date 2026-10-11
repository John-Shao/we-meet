"""Recording diarization recovery and private input erasure are independent jobs."""

from core.services import capture_diarization_inputs, capture_diarization_worker
from core.tasks._task import task


@task(queue="voiceprint-identity", time_limit=900, soft_time_limit=850)
def process_capture_diarization(identifier):
    return capture_diarization_worker.process(identifier)


@task
def tick_capture_diarization():
    for identifier in capture_diarization_worker.due():
        process_capture_diarization.delay(str(identifier))


@task
def purge_capture_diarization_inputs():
    # Erasure does not depend on the paid feature remaining enabled.
    for identifier in capture_diarization_inputs.due():
        capture_diarization_inputs.purge(identifier)
