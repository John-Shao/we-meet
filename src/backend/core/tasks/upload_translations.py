"""Durable dispatch recovery; paid translation has no automatic execution retry."""

from core.services.upload_translations import execute, tick
from core.tasks._task import task


@task(time_limit=1500, soft_time_limit=1450)
def translate_upload(job_id):
    execute(job_id)


@task
def tick_upload_translations():
    tick()
