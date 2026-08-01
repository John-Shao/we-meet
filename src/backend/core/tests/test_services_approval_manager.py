"""Approver resolution after the explicit reporting line landed (P10 M1-e).

The regression guard that matters: organizations that have not filled in
``Membership.manager`` must resolve exactly the same approver as before.
"""

import pytest
from django.db.utils import IntegrityError

from core import factories, models
from core.services.approval import _direct_manager

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE


def _member(org, user=None, **kw):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        is_primary=kw.pop("is_primary", True),
        **kw,
    )


# --- unchanged behaviour when no explicit manager is set ---------------------


def test_falls_back_to_department_head():
    org = factories.OrganizationFactory()
    boss = factories.UserFactory()
    department = models.Department.objects.create(
        organization=org, name="Eng", head=boss
    )
    applicant = _member(org, department=department)

    assert _direct_manager(applicant.user, org) == boss


def test_walks_up_past_empty_heads():
    org = factories.OrganizationFactory()
    top_boss = factories.UserFactory()
    root = models.Department.objects.create(
        organization=org, name="Root", head=top_boss
    )
    child = models.Department.objects.create(
        organization=org, name="Child", parent=root
    )
    applicant = _member(org, department=child)

    assert _direct_manager(applicant.user, org) == top_boss


def test_walks_up_past_self_as_head():
    """A department head's own approver is their parent department's head."""
    org = factories.OrganizationFactory()
    grand_boss = factories.UserFactory()
    root = models.Department.objects.create(
        organization=org, name="Root", head=grand_boss
    )
    applicant_user = factories.UserFactory()
    child = models.Department.objects.create(
        organization=org, name="Child", parent=root, head=applicant_user
    )
    _member(org, user=applicant_user, department=child)

    assert _direct_manager(applicant_user, org) == grand_boss


def test_none_when_no_head_anywhere():
    org = factories.OrganizationFactory()
    department = models.Department.objects.create(organization=org, name="Eng")
    applicant = _member(org, department=department)

    assert _direct_manager(applicant.user, org) is None


def test_none_without_membership():
    org = factories.OrganizationFactory()
    assert _direct_manager(factories.UserFactory(), org) is None


# --- new behaviour -----------------------------------------------------------


def test_explicit_manager_wins_over_department_head():
    org = factories.OrganizationFactory()
    head_user = factories.UserFactory()
    department = models.Department.objects.create(
        organization=org, name="Eng", head=head_user
    )
    real_manager = _member(org, department=department, is_primary=False)
    applicant = _member(org, department=department, manager=real_manager)

    assert _direct_manager(applicant.user, org) == real_manager.user


def test_departed_manager_falls_back_to_department_head():
    """A manager who left must not keep receiving approvals."""
    org = factories.OrganizationFactory()
    head_user = factories.UserFactory()
    department = models.Department.objects.create(
        organization=org, name="Eng", head=head_user
    )
    gone = _member(
        org,
        department=department,
        is_primary=False,
        status=models.MembershipStatusChoices.LEFT,
    )
    applicant = _member(org, department=department, manager=gone)

    assert _direct_manager(applicant.user, org) == head_user


def test_self_as_manager_cannot_reach_the_database():
    """The check constraint holds even against a raw ``.update()``.

    ``_direct_manager`` still guards against it defensively, but this is why
    that guard can never actually fire: a self-referencing row is unwritable.
    """
    org = factories.OrganizationFactory()
    department = models.Department.objects.create(organization=org, name="Eng")
    applicant = _member(org, department=department)

    with pytest.raises(IntegrityError):
        models.Membership.objects.filter(pk=applicant.pk).update(manager=applicant)


def test_dotted_manager_is_never_used_for_routing():
    org = factories.OrganizationFactory()
    head_user = factories.UserFactory()
    department = models.Department.objects.create(
        organization=org, name="Eng", head=head_user
    )
    dotted = _member(org, department=department, is_primary=False)
    applicant = _member(org, department=department, dotted_manager=dotted)

    assert _direct_manager(applicant.user, org) == head_user
