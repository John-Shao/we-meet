"""Independent sampler dispatch retries; no ASR or PCM runs in this task."""

from core.services.voiceprint_sampling_dispatch import process, tick
from core.tasks._task import task


@task(queue="voiceprint", time_limit=30, soft_time_limit=25)
def dispatch_voiceprint_sampler(session_id):
    return process(session_id)


@task(queue="voiceprint", time_limit=180, soft_time_limit=150)
def recover_voiceprint_samplers():
    return tick(limit=20)
