"""Organization lifecycle service tests (P0-4)."""

import uuid

from django.core.exceptions import ValidationError
from django.utils import timezone

import pytest

from core import factories, models
from core.services import organization_lifecycle

from work.models import (
    WorkAccessAudit,
    WorkMemberGrant,
    WorkOrganizationEntitlement,
    WorkReview,
    WorkRun,
    WorkTask,
)

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE


@pytest.fixture
def org():
    return factories.OrganizationFactory()


@pytest.fixture
def actor():
    return factories.UserFactory()


def _member(organization, *, user=None):
    return models.Membership.objects.create(
        organization=organization,
        user=user or factories.UserFactory(),
        org_role=models.OrgRoleChoices.MEMBER,
        status=ACTIVE,
        is_primary=True,
    )


def _entitlement(organization, *, enabled=True):
    return WorkOrganizationEntitlement.objects.create(
        organization=organization, enabled=enabled
    )


def _grant(organization, user, *, enabled=True):
    return WorkMemberGrant.objects.create(
        organization=organization, user=user, enabled=enabled
    )


def _work(organization, owner, *, review=False):
    task = WorkTask.objects.create(
        owner=owner,
        organization=organization,
        request_key=uuid.uuid4(),
        kind="communication",
        recipient="Project owner",
        goal="Clarify launch requirements",
        sources=[],
    )
    run = WorkRun.objects.create(
        task=task,
        request_key=uuid.uuid4(),
        model="test-model",
        base_url="https://model.example.invalid/v1",
        reserved_tokens=100,
        max_output_tokens=10,
    )
    if not review:
        return run, None
    return run, WorkReview.objects.create(
        source_run=run,
        request_key=uuid.uuid4(),
        selection=[],
        model="review-model",
        base_url="https://review.example.invalid/v1",
        reserved_tokens=10,
        max_output_tokens=10,
    )


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


def test_suspend_keeps_entitlement_and_grants_but_stops_work(org, actor):
    entitlement = _entitlement(org)
    membership = _member(org)
    grant = _grant(org, membership.user)
    run, review = _work(org, membership.user, review=True)

    result = organization_lifecycle.suspend(org, actor=actor, reason="maintenance")

    org.refresh_from_db()
    entitlement.refresh_from_db()
    grant.refresh_from_db()
    run.refresh_from_db()
    review.refresh_from_db()
    assert result["changed"] is True
    assert org.is_active is False and org.archived_at is None
    assert entitlement.enabled is True
    assert grant.enabled is True and grant.revoked_at is None
    assert (run.status, run.error_code) == ("canceled", "org_disabled")
    assert (review.status, review.error_code) == ("canceled", "org_disabled")
    audit = models.AuditLog.objects.get(
        action=models.AuditActionChoices.ORGANIZATION_SUSPENDED
    )
    assert audit.actor_id == actor.id
    assert audit.metadata["reason"] == "maintenance"
    assert audit.metadata["runs_cancelled"] == 1
    assert audit.metadata["reviews_cancelled"] == 1


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


def test_archive_closes_entitlement_revokes_grants_and_stops_work(org, actor):
    entitlement = _entitlement(org)
    membership = _member(org)
    grant = _grant(org, membership.user)
    run, review = _work(org, membership.user, review=True)

    result = organization_lifecycle.archive(org, actor=actor, reason="contract ended")

    org.refresh_from_db()
    entitlement.refresh_from_db()
    grant.refresh_from_db()
    run.refresh_from_db()
    review.refresh_from_db()
    assert result["changed"] is True
    assert result["counts"] == {
        "grants_revoked": 1,
        "runs_cancelled": 1,
        "reviews_cancelled": 1,
    }
    assert org.archived_at is not None
    assert org.is_active is False
    assert org.archive_reason == "contract ended"
    assert entitlement.enabled is False
    assert entitlement.disabled_reason == "organization_archived"
    assert grant.enabled is False
    assert grant.revoked_at is not None
    assert grant.revoked_reason == WorkMemberGrant.RevokedReason.ORGANIZATION_ARCHIVED
    assert grant.revoked_by_id == actor.id
    assert (run.status, run.error_code) == ("canceled", "org_disabled")
    assert (review.status, review.error_code) == ("canceled", "org_disabled")

    grant_audit = WorkAccessAudit.objects.get(action=WorkAccessAudit.Action.GRANT_REVOKED)
    assert grant_audit.target_id == str(grant.pk)
    assert grant_audit.actor_id == actor.id
    assert grant_audit.before["enabled"] is True
    assert grant_audit.after["enabled"] is False
    assert grant_audit.after["revoked_reason"] == "organization_archived"

    audit = models.AuditLog.objects.get(
        action=models.AuditActionChoices.ORGANIZATION_ARCHIVED
    )
    assert audit.metadata["reason"] == "contract ended"
    assert audit.metadata["grants_revoked"] == 1


def test_archive_is_idempotent(org, actor):
    _entitlement(org)
    membership = _member(org)
    _grant(org, membership.user)

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
    assert (
        WorkAccessAudit.objects.filter(
            action=WorkAccessAudit.Action.GRANT_REVOKED
        ).count()
        == 1
    )
    org = models.Organization.objects.get(pk=org.pk)
    assert org.archived_at == archived_at


def test_archive_still_revokes_when_the_audit_insert_fails(org, actor, monkeypatch):
    _entitlement(org)
    membership = _member(org)
    grant = _grant(org, membership.user)

    def unavailable(*args, **kwargs):
        raise RuntimeError("audit store unavailable")

    monkeypatch.setattr(
        WorkAccessAudit.objects, "bulk_create", unavailable, raising=False
    )

    result = organization_lifecycle.archive(org, actor=actor)

    org.refresh_from_db()
    grant.refresh_from_db()
    assert result["changed"] is True
    assert org.archived_at is not None
    assert grant.enabled is False
    assert grant.revoked_at is not None


def test_restore_reopens_organization_without_regranting(org, actor):
    entitlement = _entitlement(org)
    membership = _member(org)
    grant = _grant(org, membership.user)
    organization_lifecycle.archive(org, actor=actor, reason="contract ended")

    result = organization_lifecycle.restore(org, actor=actor, reason="renewed")

    org.refresh_from_db()
    entitlement.refresh_from_db()
    grant.refresh_from_db()
    assert result["changed"] is True
    assert org.archived_at is None
    assert org.archive_reason == ""
    assert org.is_active is True
    assert entitlement.enabled is False
    assert grant.enabled is False and grant.revoked_at is not None
    audit = models.AuditLog.objects.get(
        action=models.AuditActionChoices.ORGANIZATION_RESTORED
    )
    assert audit.metadata["previous_archive_reason"] == "contract ended"
    assert audit.metadata["reason"] == "renewed"


def test_restore_on_active_organization_is_a_noop(org, actor):
    assert organization_lifecycle.restore(org, actor=actor)["changed"] is False


def test_archive_rolls_back_when_terminal_backlog_is_too_large(
    org, actor, monkeypatch
):
    entitlement = _entitlement(org)
    membership = _member(org)
    grant = _grant(org, membership.user)
    _work(org, membership.user)
    monkeypatch.setattr(organization_lifecycle, "MAX_TERMINAL_ROWS", 0)

    with pytest.raises(organization_lifecycle.LifecycleError) as exc:
        organization_lifecycle.archive(org, actor=actor)
    assert exc.value.code == "too_many_rows"

    org.refresh_from_db()
    entitlement.refresh_from_db()
    grant.refresh_from_db()
    assert org.archived_at is None
    assert org.is_active is True
    assert entitlement.enabled is True
    assert grant.enabled is True and grant.revoked_at is None


def test_preview_counts_archived_candidates(org):
    _entitlement(org)
    membership = _member(org)
    _grant(org, membership.user)
    _work(org, membership.user, review=True)

    counts = organization_lifecycle.preview_counts(org, action="archive")
    assert counts == {
        "grants_revoked": 1,
        "runs_cancelled": 1,
        "reviews_cancelled": 1,
    }
    assert organization_lifecycle.preview_counts(org, action="suspend")[
        "grants_revoked"
    ] == 0
