"""Independent sampler dispatch retries; no ASR or PCM runs in this task."""

from core.services.voiceprint_sampling_dispatch import SamplingDispatchError, dispatch
from core.tasks._task import task


@task(autoretry_for=(SamplingDispatchError,), retry_backoff=True, max_retries=3)
def dispatch_voiceprint_sampler(session_id):
    return dispatch(session_id)
