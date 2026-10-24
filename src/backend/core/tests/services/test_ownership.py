"""Ownership transfer service tests (P0-1)."""

import pytest

from core import factories, models
from core.services import membership as membership_service
from core.services import ownership

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
SUSPENDED = models.MembershipStatusChoices.SUSPENDED
OWNER = models.OrgRoleChoices.OWNER
ADMIN = models.OrgRoleChoices.ADMIN
MEMBER = models.OrgRoleChoices.MEMBER


def _member(organization, *, role=MEMBER, status=ACTIVE, primary=True):
    return models.Membership.objects.create(
        organization=organization,
        user=factories.UserFactory(),
        org_role=role,
        status=status,
        is_primary=primary,
    )


@pytest.fixture
def org():
    return factories.OrganizationFactory()


def test_transfer_moves_owner_and_demotes_actor(org):
    actor = _member(org, role=OWNER)
    target = _member(org, role=MEMBER)

    returned_actor, returned_target = ownership.transfer_ownership(
        actor_membership=actor, target_membership=target
    )

    actor.refresh_from_db()
    target.refresh_from_db()
    assert actor.org_role == ADMIN
    assert target.org_role == OWNER
    assert returned_actor.org_role == ADMIN
    assert returned_target.org_role == OWNER
    assert models.AuditLog.objects.filter(
        action=models.AuditActionChoices.MEMBER_OWNER_TRANSFERRED,
        target_id=str(target.id),
    ).exists()


def test_transfer_requires_active_owner(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=MEMBER)

    with pytest.raises(ownership.OwnershipError) as exc:
        ownership.transfer_ownership(
            actor_membership=actor, target_membership=target
        )
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "not_organization_owner"


def test_transfer_rejects_suspended_target(org):
    actor = _member(org, role=OWNER)
    target = _member(org, role=MEMBER, status=SUSPENDED)

    with pytest.raises(ownership.OwnershipError) as exc:
        ownership.transfer_ownership(
            actor_membership=actor, target_membership=target
        )
    assert exc.value.detail["code"] == "target_not_active"


def test_transfer_rejects_self(org):
    actor = _member(org, role=OWNER)
    with pytest.raises(ownership.OwnershipError) as exc:
        ownership.transfer_ownership(
            actor_membership=actor, target_membership=actor
        )
    assert exc.value.detail["code"] == "target_is_self"


def test_transfer_rejects_existing_owner_but_keeps_multi_owner(org):
    actor = _member(org, role=OWNER)
    other = _member(org, role=OWNER)
    target = _member(org, role=MEMBER)

    with pytest.raises(ownership.OwnershipError) as exc:
        ownership.transfer_ownership(
            actor_membership=actor, target_membership=other
        )
    assert exc.value.detail["code"] == "target_already_owner"

    # A co-owner transfer is still allowed and leaves the other owner intact.
    ownership.transfer_ownership(actor_membership=actor, target_membership=target)
    actor.refresh_from_db()
    other.refresh_from_db()
    target.refresh_from_db()
    assert actor.org_role == ADMIN
    assert other.org_role == OWNER
    assert target.org_role == OWNER


def test_transfer_is_idempotent_after_actor_demoted(org):
    actor = _member(org, role=OWNER)
    target = _member(org, role=MEMBER)
    ownership.transfer_ownership(actor_membership=actor, target_membership=target)

    target.refresh_from_db()
    with pytest.raises(ownership.OwnershipError) as exc:
        ownership.transfer_ownership(
            actor_membership=actor, target_membership=target
        )
    assert exc.value.detail["code"] == "not_organization_owner"


def test_set_role_enforces_owner_cap(org):
    actor = _member(org, role=OWNER)
    _member(org, role=OWNER)
    _member(org, role=OWNER)
    target = _member(org, role=MEMBER)

    with pytest.raises(membership_service.MembershipWriteError) as exc:
        membership_service.set_role(target, actor=actor.user, role=OWNER)
    assert "at most 3 active owners" in str(exc.value.detail["org_role"])

    target.refresh_from_db()
    assert target.org_role == MEMBER


def test_set_role_requires_owner_to_grant(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=MEMBER)

    with pytest.raises(membership_service.MembershipWriteError) as exc:
        membership_service.set_role(target, actor=actor.user, role=OWNER)
    assert "active owner" in str(exc.value.detail["org_role"])


def test_set_role_keeps_last_owner(org):
    actor = _member(org, role=OWNER)
    with pytest.raises(membership_service.MembershipWriteError) as exc:
        membership_service.set_role(actor, actor=actor.user, role=ADMIN)
    assert "at least one active owner" in str(exc.value.detail["detail"])


def test_set_role_demotes_owner_when_another_exists(org):
    actor = _member(org, role=OWNER)
    target = _member(org, role=OWNER)

    membership_service.set_role(target, actor=actor.user, role=ADMIN)
    target.refresh_from_db()
    assert target.org_role == ADMIN


def test_set_status_blocks_last_owner_suspension(org):
    actor = _member(org, role=OWNER)
    with pytest.raises(membership_service.MembershipWriteError) as exc:
        membership_service.set_status(actor, actor=actor.user, status=SUSPENDED)
    assert "at least one active owner" in str(exc.value.detail["detail"])


def test_set_status_reactivating_owner_requires_owner(org):
    actor = _member(org, role=ADMIN)
    sleeping_owner = _member(org, role=OWNER, status=SUSPENDED)

    with pytest.raises(membership_service.MembershipWriteError) as exc:
        membership_service.set_status(
            sleeping_owner, actor=actor.user, status=ACTIVE
        )
    assert "active owner" in str(exc.value.detail["org_role"])

    sleeping_owner.refresh_from_db()
    assert sleeping_owner.status == SUSPENDED


def test_set_status_reactivating_owner_respects_cap(org):
    actor = _member(org, role=OWNER)
    _member(org, role=OWNER)
    _member(org, role=OWNER)
    sleeping_owner = _member(org, role=OWNER, status=SUSPENDED)

    with pytest.raises(membership_service.MembershipWriteError) as exc:
        membership_service.set_status(
            sleeping_owner, actor=actor.user, status=ACTIVE
        )
    assert "at most 3 active owners" in str(exc.value.detail["org_role"])

    sleeping_owner.refresh_from_db()
    assert sleeping_owner.status == SUSPENDED


def test_set_status_reactivating_owner_below_cap(org):
    actor = _member(org, role=OWNER)
    sleeping_owner = _member(org, role=OWNER, status=SUSPENDED)

    membership_service.set_status(sleeping_owner, actor=actor.user, status=ACTIVE)
    sleeping_owner.refresh_from_db()
    assert sleeping_owner.status == ACTIVE
    assert membership_service.active_owner_count(org.id) == 2


def test_set_status_rejects_left(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=MEMBER)

    with pytest.raises(membership_service.MembershipWriteError) as exc:
        membership_service.set_status(
            target,
            actor=actor.user,
            status=models.MembershipStatusChoices.LEFT,
        )
    assert "offboard" in str(exc.value.detail["status"]).lower()
