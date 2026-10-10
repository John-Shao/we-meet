"""Physical revocation cleanup remains scheduled when voiceprint use is off."""

from core.services.voiceprint_erasure import tick
from core.tasks._task import task


@task(queue="voiceprint", time_limit=180, soft_time_limit=150, ignore_result=True)
def purge_voiceprints():
    return tick(limit=20)
