"""Host directory fields for Work OrgDiscovery (P1-A)."""

from django.core.exceptions import ValidationError

import pytest

from core.factories import MembershipFactory, OrganizationFactory
from core.models import Membership, Organization

pytestmark = pytest.mark.django_db


def test_directory_defaults_do_not_infer_work_seat():
    organization = OrganizationFactory()
    membership = MembershipFactory(
        organization=organization,
        status="active",
        org_role="owner",
    )

    organization.refresh_from_db()
    membership.refresh_from_db()
    assert organization.home_region == "cn-north"
    assert organization.directory_revision == 2
    assert membership.work_seat is False
    assert membership.directory_revision == 2


def test_membership_changes_share_the_organization_sequence():
    organization = OrganizationFactory()
    first = MembershipFactory(organization=organization)
    second = MembershipFactory(organization=organization)
    organization.refresh_from_db()
    first.refresh_from_db()
    second.refresh_from_db()
    assert (
        organization.directory_revision,
        first.directory_revision,
        second.directory_revision,
    ) == (3, 2, 3)

    first.work_seat = True
    first.save(update_fields=["work_seat"])
    organization.refresh_from_db()
    first.refresh_from_db()
    second.refresh_from_db()
    assert (
        organization.directory_revision,
        first.directory_revision,
        second.directory_revision,
    ) == (4, 4, 3)

    organization.name = "Renamed organization"
    organization.save()
    organization.refresh_from_db()
    first.refresh_from_db()
    assert organization.directory_revision == 5
    assert first.directory_revision == 4


def test_bulk_membership_update_advances_the_sequence():
    organization = OrganizationFactory()
    membership = MembershipFactory(organization=organization)

    Membership.objects.filter(pk=membership.pk).update(status="left")

    organization.refresh_from_db()
    membership.refresh_from_db()
    assert organization.directory_revision == 3
    assert membership.directory_revision == 3


def test_membership_move_advances_both_organizations():
    source = OrganizationFactory()
    target = OrganizationFactory()
    membership = MembershipFactory(organization=source)
    source.refresh_from_db()
    target.refresh_from_db()
    assert (source.directory_revision, target.directory_revision) == (2, 1)

    membership.department = None
    membership.organization = target
    membership.save(update_fields=["organization", "department"])

    source.refresh_from_db()
    target.refresh_from_db()
    membership.refresh_from_db()
    assert source.directory_revision == 3
    assert target.directory_revision == 2
    assert membership.directory_revision == 2


def test_hard_delete_advances_the_organization_sequence():
    organization = OrganizationFactory()
    membership = MembershipFactory(organization=organization)
    organization.refresh_from_db()
    assert organization.directory_revision == 2

    membership.delete()

    organization.refresh_from_db()
    assert organization.directory_revision == 3


def test_home_region_is_validated():
    organization = OrganizationFactory()
    organization.home_region = "CN NORTH"
    with pytest.raises(ValidationError):
        organization.full_clean()
