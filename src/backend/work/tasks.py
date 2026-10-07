"""Dedicated work queue; durable DB claims recover missed deliveries."""

from celery import shared_task

from .agent_runs import process_agent_runs
from .runs import process_runs
from .services import process_materials


@shared_task(queue="work", soft_time_limit=60, time_limit=90)
def tick_materials():
    """Bound each pass; expired claims are resumed by later passes."""
    return process_materials()


@shared_task(queue="work", soft_time_limit=65, time_limit=80)
def tick_runs():
    """One fixed flow per tick; expired provider attempts are never replayed."""
    return process_runs()


@shared_task(queue="work", soft_time_limit=55, time_limit=65)
def tick_agent_runs():
    """Short HTTP reconciliation; model/tool loops run in the separate service."""
    from .local_runs import expire_runs  # noqa: PLC0415

    expire_runs()
    return process_agent_runs()
