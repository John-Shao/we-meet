"""Organization lifecycle service tests (P0-4)."""
# pylint: disable=missing-function-docstring,redefined-outer-name

from django.core.exceptions import ValidationError
from django.utils import timezone

import pytest

from core import factories, models
from core.services import organization_lifecycle

pytestmark = pytest.mark.django_db



@pytest.fixture
def org():
    return factories.OrganizationFactory()


@pytest.fixture
def actor():
    return factories.UserFactory()


def test_state_derivation(org):
    assert organization_lifecycle.organization_state(org) == "active"
    org.is_active = False
    org.save(update_fields=["is_active"])
    assert organization_lifecycle.organization_state(org) == "suspended"
    org.archived_at = timezone.now()
    org.save(update_fields=["archived_at"])
    assert organization_lifecycle.organization_state(org) == "archived"


def test_archived_organization_must_be_inactive(org):
    org.archived_at = timezone.now()
    with pytest.raises(ValidationError):
        org.save(update_fields=["archived_at"])


def test_suspend_sets_inactive_and_audits(org, actor):
    result = organization_lifecycle.suspend(org, actor=actor, reason="maintenance")

    org.refresh_from_db()
    assert result["changed"] is True
    assert result["counts"] == {}
    assert org.is_active is False and org.archived_at is None
    audit = models.AuditLog.objects.get(
        action=models.AuditActionChoices.ORGANIZATION_SUSPENDED
    )
    assert audit.actor_id == actor.id
    assert audit.metadata["reason"] == "maintenance"


def test_suspend_and_activate_are_idempotent(org, actor):
    first = organization_lifecycle.suspend(org, actor=actor)
    second = organization_lifecycle.suspend(org, actor=actor)
    assert first["changed"] is True
    assert second["changed"] is False
    assert (
        models.AuditLog.objects.filter(
            action=models.AuditActionChoices.ORGANIZATION_SUSPENDED
        ).count()
        == 1
    )

    assert organization_lifecycle.activate(org, actor=actor)["changed"] is True
    assert organization_lifecycle.activate(org, actor=actor)["changed"] is False
    org.refresh_from_db()
    assert org.is_active is True
    assert (
        models.AuditLog.objects.filter(
            action=models.AuditActionChoices.ORGANIZATION_ACTIVATED
        ).count()
        == 1
    )


def test_archived_organization_cannot_suspend_or_activate(org, actor):
    organization_lifecycle.archive(org, actor=actor)
    for handler in (
        organization_lifecycle.suspend,
        organization_lifecycle.activate,
    ):
        with pytest.raises(organization_lifecycle.LifecycleError) as exc:
            handler(org, actor=actor)
        assert exc.value.code == "organization_archived"


def test_archive_sets_fields_and_audits(org, actor):
    result = organization_lifecycle.archive(org, actor=actor, reason="contract ended")

    org.refresh_from_db()
    assert result["changed"] is True
    assert result["counts"] == {}
    assert org.archived_at is not None
    assert org.is_active is False
    assert org.archive_reason == "contract ended"

    audit = models.AuditLog.objects.get(
        action=models.AuditActionChoices.ORGANIZATION_ARCHIVED
    )
    assert audit.metadata["reason"] == "contract ended"


def test_archive_is_idempotent(org, actor):
    first = organization_lifecycle.archive(org, actor=actor)
    org.refresh_from_db()
    archived_at = org.archived_at
    second = organization_lifecycle.archive(org, actor=actor)

    assert first["changed"] is True
    assert second["changed"] is False
    assert (
        models.AuditLog.objects.filter(
            action=models.AuditActionChoices.ORGANIZATION_ARCHIVED
        ).count()
        == 1
    )
    org = models.Organization.objects.get(pk=org.pk)
    assert org.archived_at == archived_at


def test_restore_reopens_organization(org, actor):
    organization_lifecycle.archive(org, actor=actor, reason="contract ended")

    result = organization_lifecycle.restore(org, actor=actor, reason="renewed")

    org.refresh_from_db()
    assert result["changed"] is True
    assert org.archived_at is None
    assert org.archive_reason == ""
    assert org.is_active is True
    audit = models.AuditLog.objects.get(
        action=models.AuditActionChoices.ORGANIZATION_RESTORED
    )
    assert audit.metadata["previous_archive_reason"] == "contract ended"
    assert audit.metadata["reason"] == "renewed"


def test_restore_on_active_organization_is_a_noop(org, actor):
    assert organization_lifecycle.restore(org, actor=actor)["changed"] is False
