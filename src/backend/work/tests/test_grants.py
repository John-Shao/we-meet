"""Seat-limited grant writes: distinct persons, expiry and revocation (P0-3)."""

import threading
from datetime import timedelta

from django.db import connections
from django.utils import timezone

import pytest

from core import factories, models

from work import grants
from work.models import (
    WorkAccessAudit,
    WorkMemberGrant,
    WorkOrganizationEntitlement,
)

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE


def _tenant(member_limit=None, *, entitled=True, enabled=True):
    org = factories.OrganizationFactory()
    if entitled:
        WorkOrganizationEntitlement.objects.create(
            organization=org,
            enabled=enabled,
            member_limit=member_limit,
        )
    return org


def _person(org):
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=org,
        user=user,
        status=ACTIVE,
        is_primary=True,
    )
    return user


def test_unlimited_when_member_limit_is_none():
    org = _tenant()

    for _ in range(4):
        grants.grant_member(organization_id=org.id, user_id=_person(org).id)

    assert grants.active_seats(org.id) == 4


def test_member_limit_rejects_the_extra_person():
    org = _tenant(member_limit=2)
    grants.grant_member(organization_id=org.id, user_id=_person(org).id)
    grants.grant_member(organization_id=org.id, user_id=_person(org).id)
    third = _person(org)

    with pytest.raises(grants.MemberLimitReached) as exc:
        grants.grant_member(organization_id=org.id, user_id=third.id)

    assert exc.value.detail["code"] == "member_limit_reached"
    assert exc.value.detail["meta"] == {"limit": 2, "active": 2}
    assert not WorkMemberGrant.objects.filter(user=third).exists()


def test_expired_grant_releases_its_seat():
    org = _tenant(member_limit=1)
    first = _person(org)
    WorkMemberGrant.objects.create(
        organization=org,
        user=first,
        enabled=True,
        expires_at=timezone.now() - timedelta(minutes=1),
    )

    second = _person(org)
    grants.grant_member(organization_id=org.id, user_id=second.id)

    assert grants.active_seats(org.id) == 1
    assert grants.seat_usage(org.id) == {"active": 1, "limit": 1}


def test_revoked_grant_releases_seat_and_revives_in_place():
    org = _tenant(member_limit=2)
    user = _person(org)
    grant = grants.grant_member(organization_id=org.id, user_id=user.id)
    grants.revoke_member_grant(organization_id=org.id, user_id=user.id)

    second = _person(org)
    grants.grant_member(organization_id=org.id, user_id=second.id)

    revived = grants.grant_member(organization_id=org.id, user_id=user.id)

    assert revived.pk == grant.pk
    assert (revived.enabled, revived.revoked_at, revived.revoked_reason) == (
        True,
        None,
        "",
    )
    assert WorkMemberGrant.objects.filter(organization=org).count() == 2
    assert WorkAccessAudit.objects.filter(
        action=WorkAccessAudit.Action.GRANT_RESTORED, target_id=str(grant.pk)
    ).exists()
    # The revived row takes the free seat; both grants are valid again.
    assert grants.active_seats(org.id) == 2


def test_restore_rechecks_the_seat_limit():
    org = _tenant(member_limit=1)
    first = _person(org)
    grants.grant_member(organization_id=org.id, user_id=first.id)
    grants.revoke_member_grant(organization_id=org.id, user_id=first.id)
    grants.grant_member(organization_id=org.id, user_id=_person(org).id)

    with pytest.raises(grants.MemberLimitReached):
        grants.restore_member_grant(organization_id=org.id, user_id=first.id)

    grant = WorkMemberGrant.objects.get(organization=org, user=first)
    assert grant.revoked_at is not None
    assert grant.is_active() is False


def test_suspended_member_cannot_receive_a_seat():
    org = _tenant()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=org,
        user=user,
        status=models.MembershipStatusChoices.SUSPENDED,
        is_primary=True,
    )

    with pytest.raises(grants.GrantRejected) as exc:
        grants.grant_member(organization_id=org.id, user_id=user.id)

    assert exc.value.detail["code"] == "member_not_active"


def test_disabled_entitlement_rejects_grants():
    org = _tenant(enabled=False)
    user = _person(org)

    with pytest.raises(grants.GrantRejected) as exc:
        grants.grant_member(organization_id=org.id, user_id=user.id)

    assert exc.value.detail["code"] == "org_disabled"


def test_manual_disable_does_not_record_a_revocation():
    org = _tenant(member_limit=1)
    user = _person(org)
    grants.grant_member(organization_id=org.id, user_id=user.id)

    disabled = grants.disable_member_grant(organization_id=org.id, user_id=user.id)

    assert disabled.enabled is False
    assert disabled.revoked_at is None
    assert grants.active_seats(org.id) == 0
    assert WorkMemberGrant.objects.get(user=user).revoked_reason == ""

    # Re-enabling an untouched row is an update, not a revival of a revocation.
    grants.grant_member(organization_id=org.id, user_id=user.id)
    assert not WorkAccessAudit.objects.filter(
        action=WorkAccessAudit.Action.GRANT_RESTORED
    ).exists()


def test_granting_an_active_member_is_idempotent_and_keeps_one_seat():
    org = _tenant(member_limit=1)
    user = _person(org)

    first = grants.grant_member(organization_id=org.id, user_id=user.id)
    second = grants.grant_member(organization_id=org.id, user_id=user.id)

    assert first.pk == second.pk
    assert WorkMemberGrant.objects.filter(organization=org).count() == 1
    assert grants.active_seats(org.id) == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_grants_take_exactly_one_last_seat():
    org = _tenant(member_limit=1)
    people = [_person(org) for _ in range(5)]
    barrier = threading.Barrier(len(people))
    outcomes = []
    lock = threading.Lock()

    def claim(user_id):
        try:
            barrier.wait(timeout=10)
            grants.grant_member(organization_id=org.id, user_id=user_id)
            result = "granted"
        except grants.MemberLimitReached:
            result = "rejected"
        except Exception as exc:  # noqa: BLE001 -- surfaced by the assertion
            result = type(exc).__name__
        finally:
            connections.close_all()
        with lock:
            outcomes.append(result)

    threads = [
        threading.Thread(target=claim, args=(person.id,)) for person in people
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert outcomes.count("granted") == 1, outcomes
    assert outcomes.count("rejected") == 4, outcomes
    assert grants.active_seats(org.id) == 1


def test_seat_usage_reports_unlimited_tenants():
    org = _tenant()
    grants.grant_member(organization_id=org.id, user_id=_person(org).id)

    assert grants.seat_usage(org.id) == {"active": 1, "limit": None}


def test_grant_audit_attributes_each_write_to_its_operator():
    org = _tenant()
    user = _person(org)
    granter = factories.UserFactory()
    operator = factories.UserFactory()

    grant = grants.grant_member(
        organization_id=org.id, user_id=user.id, actor=granter
    )
    grants.disable_member_grant(
        organization_id=org.id, user_id=user.id, actor=operator
    )
    grants.grant_member(organization_id=org.id, user_id=user.id, actor=operator)
    grants.revoke_member_grant(
        organization_id=org.id, user_id=user.id, actor=operator
    )
    grants.restore_member_grant(
        organization_id=org.id, user_id=user.id, actor=granter
    )

    rows = WorkAccessAudit.objects.filter(target_id=str(grant.pk))
    assert rows.get(action=WorkAccessAudit.Action.GRANT_CREATED).actor_id == granter.id
    assert set(
        rows.filter(action=WorkAccessAudit.Action.GRANT_UPDATED).values_list(
            "actor_id", flat=True
        )
    ) == {operator.id}
    assert rows.get(action=WorkAccessAudit.Action.GRANT_REVOKED).actor_id == operator.id
    assert rows.get(action=WorkAccessAudit.Action.GRANT_RESTORED).actor_id == granter.id
