"""Provider-only organization lifecycle: suspend, activate, archive, restore.

Every write to ``archived_at`` / ``archive_reason`` goes through here, and the
Django admin actions and management command are thin wrappers so the side
effects cannot drift between entry points. The legacy Work side effects were
removed with the clean-slate reset; this service now only manages the
organization row and its audit record.
"""

from django.db import transaction
from django.utils import timezone

from core.models import AuditActionChoices, Organization
from core.services.audit import record_audit



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
    _audit(
        organization,
        AuditActionChoices.ORGANIZATION_SUSPENDED,
        actor,
        {"reason": reason, "previous_state": "active"},
    )
    return {
        "action": "suspend",
        "changed": True,
        "organization": organization.slug,
        "counts": {},
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
    organization = _locked(organization)
    if organization.archived_at is not None:
        return {"changed": False, "organization": organization.slug, "counts": {}}

    organization.is_active = False
    organization.archived_at = timezone.now()
    organization.archive_reason = (reason or "")[:200]
    organization.save(
        update_fields=["is_active", "archived_at", "archive_reason", "updated_at"]
    )
    _audit(
        organization,
        AuditActionChoices.ORGANIZATION_ARCHIVED,
        actor,
        {"reason": organization.archive_reason},
    )
    return {
        "action": "archive",
        "changed": True,
        "organization": organization.slug,
        "counts": {},
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
