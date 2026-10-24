"""Provider-only organization lifecycle: suspend, activate, archive, restore.

Every write to ``archived_at`` / ``archive_reason`` goes through here, and the
Django admin actions and management command are thin wrappers so the side
effects cannot drift between entry points. Archiving closes the Work
entitlement, revokes every grant and stops queued work in one transaction;
restoring re-opens the organization but deliberately does not hand access back.
"""

import logging

from django.db import transaction
from django.utils import timezone

from core.models import AuditActionChoices, Organization
from core.services.audit import record_audit

logger = logging.getLogger(__name__)

MAX_TERMINAL_ROWS = 1000
ACTIVE_RUN_STATUSES = ("queued", "running")


class LifecycleError(Exception):
    """A refused transition. The command turns ``code`` into its exit message."""

    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def organization_state(organization):
    if organization.archived_at is not None:
        return "archived"
    return "active" if organization.is_active else "suspended"


def _locked(organization):
    pk = getattr(organization, "pk", organization)
    return Organization.objects.select_for_update().get(pk=pk)


def _actor_user(actor):
    return actor if getattr(actor, "is_authenticated", False) else None


def _work_querysets(organization_id):
    # Imported lazily: core must not import work while apps are loading.
    from work.models import WorkReview, WorkRun  # noqa: PLC0415

    runs = WorkRun.objects.filter(
        task__organization_id=organization_id, status__in=ACTIVE_RUN_STATUSES
    )
    reviews = WorkReview.objects.filter(
        source_run__task__organization_id=organization_id,
        status__in=ACTIVE_RUN_STATUSES,
    )
    return runs, reviews


def preview_counts(organization, *, action):
    """What ``action`` would touch, without writing."""
    runs, reviews = _work_querysets(organization.id)
    from work.models import WorkMemberGrant  # noqa: PLC0415

    return {
        "grants_revoked": (
            WorkMemberGrant.objects.filter(
                organization_id=organization.id, revoked_at__isnull=True
            ).count()
            if action == "archive"
            else 0
        ),
        "runs_cancelled": runs.count(),
        "reviews_cancelled": reviews.count(),
    }


def _terminate_work(organization_id):
    from work import runs as work_runs  # noqa: PLC0415

    runs, reviews = _work_querysets(organization_id)
    runs = list(runs.select_for_update())
    reviews = list(reviews.select_for_update())
    if len(runs) > MAX_TERMINAL_ROWS or len(reviews) > MAX_TERMINAL_ROWS:
        raise LifecycleError(
            "too_many_rows",
            "More than %d queued items; run this during a maintenance window."
            % MAX_TERMINAL_ROWS,
        )
    for run in runs:
        work_runs.terminal(run, "canceled", "org_disabled")
    for review in reviews:
        work_runs.terminal(review, "canceled", "org_disabled")
    return {"runs_cancelled": len(runs), "reviews_cancelled": len(reviews)}


def _audit(organization, action, actor, metadata):
    record_audit(
        actor=actor,
        organization=organization,
        action=action,
        target_type="organization",
        target_id=organization.id,
        target_label=organization.name,
        metadata=metadata,
    )


@transaction.atomic
def suspend(organization, *, actor=None, reason=""):
    organization = _locked(organization)
    if organization.archived_at is not None:
        raise LifecycleError(
            "organization_archived",
            "Restore the organization before changing its active state.",
        )
    if not organization.is_active:
        return {"changed": False, "organization": organization.slug, "counts": {}}

    organization.is_active = False
    organization.save(update_fields=["is_active", "updated_at"])
    counts = _terminate_work(organization.id)
    _audit(
        organization,
        AuditActionChoices.ORGANIZATION_SUSPENDED,
        actor,
        {"reason": reason, "previous_state": "active", **counts},
    )
    return {
        "action": "suspend",
        "changed": True,
        "organization": organization.slug,
        "counts": {"grants_revoked": 0, **counts},
    }


@transaction.atomic
def activate(organization, *, actor=None, reason=""):
    organization = _locked(organization)
    if organization.archived_at is not None:
        raise LifecycleError(
            "organization_archived",
            "Restore the organization before activating it.",
        )
    if organization.is_active:
        return {"changed": False, "organization": organization.slug, "counts": {}}

    organization.is_active = True
    organization.save(update_fields=["is_active", "updated_at"])
    _audit(
        organization,
        AuditActionChoices.ORGANIZATION_ACTIVATED,
        actor,
        {"reason": reason, "previous_state": "suspended"},
    )
    return {
        "action": "activate",
        "changed": True,
        "organization": organization.slug,
        "counts": {},
    }


@transaction.atomic
def archive(organization, *, actor=None, reason=""):
    from work import audit as work_audit  # noqa: PLC0415
    from work.models import (  # noqa: PLC0415
        WorkAccessAudit,
        WorkMemberGrant,
        WorkOrganizationEntitlement,
    )

    organization = _locked(organization)
    if organization.archived_at is not None:
        return {"changed": False, "organization": organization.slug, "counts": {}}

    organization.is_active = False
    organization.archived_at = timezone.now()
    organization.archive_reason = (reason or "")[:200]
    organization.save(
        update_fields=["is_active", "archived_at", "archive_reason", "updated_at"]
    )

    entitlement = (
        WorkOrganizationEntitlement.objects.select_for_update()
        .filter(organization_id=organization.id)
        .first()
    )
    if entitlement is not None:
        entitlement.enabled = False
        entitlement.disabled_reason = "organization_archived"
        entitlement.updated_by = _actor_user(actor)
        entitlement.save(
            update_fields=["enabled", "disabled_reason", "updated_by", "updated_at"]
        )

    grants = list(
        WorkMemberGrant.objects.select_for_update().filter(
            organization_id=organization.id, revoked_at__isnull=True
        )
    )
    now = timezone.now()
    audit_rows = []
    for grant in grants:
        before = work_audit.snapshot(grant)
        grant.enabled = False
        grant.revoked_at = now
        grant.revoked_reason = WorkMemberGrant.RevokedReason.ORGANIZATION_ARCHIVED
        grant.revoked_by = _actor_user(actor)
        grant.updated_at = now
        audit_rows.append(
            WorkAccessAudit(
                organization_id=organization.id,
                actor=_actor_user(actor),
                action=WorkAccessAudit.Action.GRANT_REVOKED,
                target_type="grant",
                target_id=str(grant.pk),
                before=before,
            )
        )
    if grants:
        WorkMemberGrant.objects.bulk_update(
            grants,
            ["enabled", "revoked_at", "revoked_reason", "revoked_by", "updated_at"],
        )
        # Snapshots have to read the post-write row, so fill them after the update.
        for row, grant in zip(audit_rows, grants, strict=True):
            row.after = work_audit.snapshot(grant)
        WorkAccessAudit.objects.bulk_create(audit_rows)

    counts = _terminate_work(organization.id)
    counts["grants_revoked"] = len(grants)
    _audit(
        organization,
        AuditActionChoices.ORGANIZATION_ARCHIVED,
        actor,
        {"reason": organization.archive_reason, **counts},
    )
    return {
        "action": "archive",
        "changed": True,
        "organization": organization.slug,
        "counts": counts,
    }


@transaction.atomic
def restore(organization, *, actor=None, reason=""):
    organization = _locked(organization)
    if organization.archived_at is None:
        return {"changed": False, "organization": organization.slug, "counts": {}}

    previous_reason = organization.archive_reason
    organization.archived_at = None
    organization.archive_reason = ""
    organization.is_active = True
    organization.save(
        update_fields=["archived_at", "archive_reason", "is_active", "updated_at"]
    )
    # Entitlement and grants stay closed: restoring a tenant is not a re-grant.
    _audit(
        organization,
        AuditActionChoices.ORGANIZATION_RESTORED,
        actor,
        {"reason": reason, "previous_archive_reason": previous_reason},
    )
    return {
        "action": "restore",
        "changed": True,
        "organization": organization.slug,
        "counts": {},
    }
