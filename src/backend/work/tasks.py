"""Dedicated work queue; durable DB claims recover missed deliveries."""

import logging
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from celery import shared_task

from .agent_runs import process_agent_runs
from .models import WorkAccessAudit
from .review_runs import process_reviews

logger = logging.getLogger(__name__)

#: Long transactions lock the write path; 1000 rows is short enough to stay
#: under the statement-time expectations of an ordinary OLTP deployment.
PRUNE_CHUNK = 1000


@shared_task(queue="work", soft_time_limit=55, time_limit=65)
def tick_agent_runs():
    """Short HTTP reconciliation; model/tool loops run in the separate service."""
    from .local_runs import expire_runs  # noqa: PLC0415

    expire_runs()
    return process_agent_runs()


@shared_task(queue="work", soft_time_limit=55, time_limit=65)
def tick_reviews():
    return process_reviews(limit=2)


def prune_access_audit_rows(limit=None, dry_run=None):
    """Delete expired access-audit rows in bounded batches.

    Shared by the hourly beat task and the ``prune_work_access_audit`` command so
    the cutoff and the exclusion of archived tenants exist exactly once. Returns
    ``{"deleted": n, "has_more": bool}``.

    A dry run reports the **whole** candidate set in one pass: nothing is
    deleted, so a second batch would count the same rows again. Repeating the
    batch limit here would make ``--dry-run --batches 20`` report up to twenty
    times the real backlog.

    Archived tenants keep their audit rows until the tenant itself is purged:
    a read-only tenant's history is part of the archive.
    """
    days = settings.WORK_ACCESS_AUDIT_RETENTION_DAYS
    if days <= 0:
        return {"deleted": 0, "has_more": False}

    cutoff = timezone.now() - timedelta(days=days)
    queryset = WorkAccessAudit.objects.filter(
        created_at__lt=cutoff,
        organization__archived_at__isnull=True,
    )
    budget = max(1, int(settings.WORK_ACCESS_AUDIT_PRUNE_BATCH))
    if limit is not None:
        budget = max(1, min(budget, int(limit)))
    if dry_run is None:
        dry_run = bool(settings.WORK_ACCESS_AUDIT_RETENTION_DRY_RUN)

    organizations = (
        queryset.values("organization_id").distinct().count()
        if queryset.exists()
        else 0
    )

    if dry_run:
        deleted = queryset.count()
        has_more = False
        # Counts and tenant breadth only: the rows themselves are the thing the
        # retention window exists to remove.
        logger.info(
            "work.access_audit.prune_dry_run would_delete=%s organizations=%s",
            deleted,
            organizations,
        )
        return {"deleted": deleted, "has_more": has_more}

    deleted = 0
    while deleted < budget:
        step = min(PRUNE_CHUNK, budget - deleted)
        ids = list(queryset.values_list("pk", flat=True)[:step])
        if not ids:
            break
        WorkAccessAudit.objects.filter(pk__in=ids).delete()
        deleted += len(ids)
    has_more = queryset.exists()

    logger.info(
        "work.access_audit.pruned deleted=%s has_more=%s organizations=%s",
        deleted,
        has_more,
        organizations,
    )
    return {"deleted": deleted, "has_more": has_more}


@shared_task(queue="work", soft_time_limit=60, time_limit=90)
def prune_access_audit(limit=None):
    return prune_access_audit_rows(limit=limit)
