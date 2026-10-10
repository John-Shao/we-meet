"""Expire private media and reclaim quota/origin metadata independently of ASR."""

from core.services.voiceprint_maintenance import tick
from core.tasks._task import task


@task(queue="voiceprint", time_limit=180, soft_time_limit=150)
def maintain_voiceprints():
    return tick(limit=20)
