"""Leaving an organization closes Work access in the same transaction (P0-2)."""

import io
import uuid
from datetime import timedelta

from django.core.management import call_command
from django.utils import timezone

import pytest

from core import factories, models
from core.services import offboarding

from work import lifecycle
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
LEFT = models.MembershipStatusChoices.LEFT


def _membership(org, user, *, status=ACTIVE, primary=True, department=None):
    return models.Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        status=status,
        is_primary=primary,
    )


def _grant(org, user, *, enabled=True, **extra):
    return WorkMemberGrant.objects.create(
        organization=org, user=user, enabled=enabled, **extra
    )


def _run(org, user, *, status="queued"):
    task = WorkTask.objects.create(
        owner=user,
        organization=org,
        request_key=uuid.uuid4(),
        goal="Clarify launch requirements",
    )
    return WorkRun.objects.create(
        task=task,
        request_key=uuid.uuid4(),
        status=status,
        model="test-model",
        base_url="https://model.example.invalid/v1",
        reserved_tokens=100,
        max_output_tokens=50,
    )


def _review(run, *, status="queued"):
    return WorkReview.objects.create(
        source_run=run,
        request_key=uuid.uuid4(),
        selection=[],
        status=status,
        model="test-model",
        base_url="https://model.example.invalid/v1",
        reserved_tokens=10,
        max_output_tokens=5,
    )


@pytest.fixture
def org():
    return factories.OrganizationFactory()


def test_offboard_revokes_grant_and_closes_active_work(org):
    actor = factories.UserFactory()
    target = factories.UserFactory()
    _membership(org, actor, primary=True)
    membership = _membership(org, target)
    grant = _grant(org, target)
    run = _run(org, target)
    review = _review(run)

    offboarding.offboard_membership(
        membership, actor=actor, reason="resigned", disable_login=False
    )

    grant.refresh_from_db()
    run.refresh_from_db()
    review.refresh_from_db()
    assert membership.status == LEFT
    assert grant.enabled is False
    assert grant.revoked_at is not None
    assert grant.revoked_reason == WorkMemberGrant.RevokedReason.MEMBERSHIP_LEFT
    assert grant.is_active() is False
    assert (run.status, run.error_code) == ("access_revoked", "member_disabled")
    assert (review.status, review.error_code) == ("access_revoked", "member_disabled")
    audit = WorkAccessAudit.objects.get(action=WorkAccessAudit.Action.GRANT_REVOKED)
    assert audit.target_id == str(grant.pk)
    assert audit.after["revoked_reason"] == "membership_left"


def test_departure_keeps_access_while_another_membership_is_active(org):
    actor = factories.UserFactory()
    target = factories.UserFactory()
    _membership(org, actor, primary=True)
    membership = _membership(org, target)
    _membership(
        org,
        target,
        primary=False,
        department=factories.DepartmentFactory(organization=org),
    )
    grant = _grant(org, target)

    offboarding.offboard_membership(membership, actor=actor, disable_login=False)

    grant.refresh_from_db()
    assert grant.revoked_at is None
    assert grant.is_active() is True


def test_other_organization_grant_is_untouched(org):
    other = factories.OrganizationFactory()
    target = factories.UserFactory()
    membership = _membership(org, target)
    _membership(other, target)
    ours = _grant(org, target)
    theirs = _grant(other, target)

    offboarding.offboard_membership(
        membership, actor=factories.UserFactory(), disable_login=False
    )

    ours.refresh_from_db()
    theirs.refresh_from_db()
    assert ours.revoked_at is not None
    assert theirs.revoked_at is None


def test_post_delete_fallback_revokes_grant(org):
    target = factories.UserFactory()
    membership = _membership(org, target, status=LEFT, primary=False)
    grant = _grant(org, target)

    membership.delete()

    grant.refresh_from_db()
    assert grant.revoked_at is not None
    assert grant.revoked_reason == "membership_left"


def test_signal_is_idempotent_and_keeps_first_revocation(org):
    target = factories.UserFactory()
    membership = _membership(org, target, status=LEFT, primary=False)
    first = timezone.now() - timedelta(days=1)
    grant = _grant(
        org,
        target,
        enabled=False,
        revoked_at=first,
        revoked_reason=WorkMemberGrant.RevokedReason.BACKFILL,
    )

    lifecycle.on_membership_left(sender=models.Membership, membership=membership)

    grant.refresh_from_db()
    assert grant.revoked_at == first
    assert grant.revoked_reason == "backfill"


def test_revocation_failure_rolls_back_departure(org, monkeypatch):
    target = factories.UserFactory()
    membership = _membership(org, target)
    grant = _grant(org, target)

    def boom(*args, **kwargs):
        raise RuntimeError("work unavailable")

    monkeypatch.setattr(lifecycle, "close_member_access", boom)

    with pytest.raises(RuntimeError):
        offboarding.offboard_membership(
            membership,
            actor=factories.UserFactory(),
            disable_login=False,
        )

    membership.refresh_from_db()
    grant.refresh_from_db()
    assert membership.status == ACTIVE
    assert grant.enabled is True
    assert grant.revoked_at is None


def test_backfill_command_is_idempotent(org):
    WorkOrganizationEntitlement.objects.create(organization=org, enabled=True)
    departed = factories.UserFactory()
    _membership(org, departed, status=LEFT, primary=False)
    grant = _grant(org, departed)

    out = io.StringIO()
    call_command("revoke_departed_grants", "--dry-run", stdout=out)
    grant.refresh_from_db()
    assert grant.enabled is True
    assert "would revoke 1" in out.getvalue()

    call_command("revoke_departed_grants", stdout=io.StringIO())
    grant.refresh_from_db()
    assert grant.enabled is False
    assert grant.revoked_reason == "backfill"

    revoked_at = grant.revoked_at
    call_command("revoke_departed_grants", stdout=io.StringIO())
    grant.refresh_from_db()
    assert grant.revoked_at == revoked_at
