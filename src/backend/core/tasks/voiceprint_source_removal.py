"""Drain durable biometric source removal intents, without provider IO."""

from core.services.voiceprint_source_removal import tick
from core.tasks._task import task


@task(queue="voiceprint", time_limit=180, soft_time_limit=150)
def drain_voiceprint_source_removals():
    return tick(limit=20)
