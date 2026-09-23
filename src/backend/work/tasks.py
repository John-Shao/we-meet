"""Dedicated work queue; durable DB claims recover missed deliveries."""

from celery import shared_task

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
