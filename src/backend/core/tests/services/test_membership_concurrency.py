"""Concurrency invariants for membership lifecycle writes (P0-1)."""

import threading

from django.db import connections

import pytest

from core import factories, models
from core.services import offboarding

pytestmark = pytest.mark.django_db(transaction=True)

ACTIVE = models.MembershipStatusChoices.ACTIVE
OWNER = models.OrgRoleChoices.OWNER


def _owner(org):
    return models.Membership.objects.create(
        organization=org,
        user=factories.UserFactory(),
        org_role=OWNER,
        status=ACTIVE,
        is_primary=True,
    )


def test_concurrent_offboards_never_leave_the_organization_ownerless():
    """Two owners leaving at once: exactly one is refused.

    Without the organization lock both read the other owner as present, both
    pass the guard, and the organization ends with zero owners.
    """
    org = factories.OrganizationFactory()
    owners = [_owner(org), _owner(org)]
    barrier = threading.Barrier(len(owners))
    outcomes = []
    lock = threading.Lock()

    def leave(membership_id):
        try:
            barrier.wait(timeout=10)
            membership = models.Membership.objects.get(id=membership_id)
            offboarding.offboard_membership(
                membership, actor=None, disable_login=False
            )
            result = "offboarded"
        except offboarding.OffboardError:
            result = "refused"
        except Exception as exc:  # noqa: BLE001 — surfaced by the assertion
            result = type(exc).__name__
        finally:
            connections.close_all()
        with lock:
            outcomes.append(result)

    threads = [threading.Thread(target=leave, args=(owner.id,)) for owner in owners]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert outcomes.count("offboarded") == 1, outcomes
    assert outcomes.count("refused") == 1, outcomes
    assert (
        models.Membership.objects.filter(
            organization=org, status=ACTIVE, org_role=OWNER
        ).count()
        == 1
    )
