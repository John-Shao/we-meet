"""Isolated Work governance assignments and their owner-only admin API."""

from datetime import timedelta

from django.contrib import admin
from django.test import RequestFactory
from django.urls import reverse
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services.org_permissions import get_admin_context
from core.services.work_governance import work_permissions_for_user

pytestmark = pytest.mark.django_db


class _Req:
    def __init__(self, user):
        self.user = user


def _client(user, *, auth_age=0):
    client = APIClient()
    client.force_login(user)
    session = client.session
    session["auth_time"] = (timezone.now() - timedelta(seconds=auth_age)).timestamp()
    session.save()
    return client


def _body(revision=0, permissions=None, request_id="req-work-grant"):
    return {
        "permissions": ["org.work.seat.write"] if permissions is None else permissions,
        "expected_revision": revision,
        "client_request_id": request_id,
    }


def test_owner_grants_revokes_and_emits_assignment_events():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory(sub="owner-sub")
    target = factories.UserFactory(sub="target-sub")
    factories.MembershipFactory(
        organization=organization,
        user=owner,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    factories.MembershipFactory(
        organization=organization,
        user=target,
        org_role=models.OrgRoleChoices.MEMBER,
        is_primary=True,
    )
    client = _client(owner)
    url = reverse("work-governance-assignment-detail", kwargs={"user_id": target.id})

    granted = client.put(url, _body(), format="json")
    assert granted.status_code == 200
    assert granted.json()["permissions"] == ["org.work.seat.write"]
    assert granted.json()["revision"] == 1
    assignment = models.WorkGovernanceAssignment.objects.get(
        organization=organization,
        user=target,
    )
    assert assignment.status == models.WorkGovernanceAssignmentStatusChoices.ACTIVE
    assert work_permissions_for_user(target, organization) == ["org.work.seat.write"]
    event = models.WorkGovernanceEvent.objects.get(
        organization=organization,
        command_id=granted.json()["command_id"],
    )
    assert event.kind == models.WorkGovernanceEventKindChoices.ASSIGNMENT
    assert event.permissions_revision == 1
    assert event.desired is True
    assert (
        models.AuditLog.objects.filter(
            organization=organization,
            action=models.AuditActionChoices.WORK_GOVERNANCE_GRANT,
            target_id=assignment.id,
        ).count()
        == 1
    )

    revoked = client.put(
        url,
        _body(revision=1, permissions=[], request_id="req-work-revoke"),
        format="json",
    )
    assert revoked.status_code == 200
    assignment.refresh_from_db()
    assert assignment.revision == 2
    assert assignment.status == models.WorkGovernanceAssignmentStatusChoices.REVOKED
    assert work_permissions_for_user(target, organization) == []
    assert (
        models.WorkGovernanceEvent.objects.filter(
            organization=organization,
            kind=models.WorkGovernanceEventKindChoices.ASSIGNMENT,
        ).count()
        == 2
    )


def test_admin_and_stale_owner_cannot_change_work_assignments():
    organization = factories.OrganizationFactory()
    admin = factories.UserFactory(sub="admin-sub")
    target = factories.UserFactory(sub="target-sub")
    factories.MembershipFactory(
        organization=organization,
        user=admin,
        org_role=models.OrgRoleChoices.ADMIN,
        is_primary=True,
    )
    factories.MembershipFactory(
        organization=organization,
        user=target,
        is_primary=True,
    )
    url = reverse("work-governance-assignment-detail", kwargs={"user_id": target.id})

    assert _client(admin).put(url, _body(), format="json").status_code == 403
    stale = _client(admin, auth_age=601)
    admin_membership = models.Membership.objects.get(
        organization=organization,
        user=admin,
    )
    admin_membership.org_role = models.OrgRoleChoices.OWNER
    admin_membership.save(update_fields=["org_role"])
    assert stale.put(url, _body(), format="json").status_code == 403
    assert not models.WorkGovernanceAssignment.objects.filter(
        organization=organization,
        user=target,
    ).exists()


def test_assignment_revision_conflict_has_no_side_effects():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory(sub="owner-sub")
    target = factories.UserFactory(sub="target-sub")
    factories.MembershipFactory(
        organization=organization,
        user=owner,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    factories.MembershipFactory(
        organization=organization,
        user=target,
        is_primary=True,
    )
    models.WorkGovernanceAssignment.objects.create(
        organization=organization,
        user=target,
        permissions=["org.work.seat.write"],
        revision=3,
    )
    client = _client(owner)
    url = reverse("work-governance-assignment-detail", kwargs={"user_id": target.id})

    response = client.put(
        url,
        _body(revision=2, request_id="req-stale-assignment"),
        format="json",
    )
    assert response.status_code == 409
    assignment = models.WorkGovernanceAssignment.objects.get(
        organization=organization,
        user=target,
    )
    assert assignment.revision == 3
    assert not models.WorkGovernanceEvent.objects.filter(
        organization=organization,
        kind=models.WorkGovernanceEventKindChoices.ASSIGNMENT,
    ).exists()


def test_work_assignment_does_not_widen_legacy_admin_roles():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory(sub="owner-sub")
    target = factories.UserFactory(sub="target-sub")
    owner_membership = factories.MembershipFactory(
        organization=organization,
        user=owner,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    target_membership = factories.MembershipFactory(
        organization=organization,
        user=target,
        is_primary=True,
    )
    legacy_role = models.AdminRole.objects.create(
        organization=organization,
        code="legacy_reader",
        name="Legacy reader",
        permissions=["org.member.read"],
    )
    models.AdminRoleAssignment.objects.create(
        role=legacy_role,
        membership=target_membership,
    )
    client = _client(owner)
    url = reverse("work-governance-assignment-detail", kwargs={"user_id": target.id})

    assert client.put(url, _body(), format="json").status_code == 200
    assert work_permissions_for_user(target, organization) == ["org.work.seat.write"]
    assert get_admin_context(_Req(target)).permissions == frozenset({"org.member.read"})
    assert owner_membership.org_role == models.OrgRoleChoices.OWNER


def test_django_admin_assignment_surface_is_read_only():
    model_admin = admin.site._registry[models.WorkGovernanceAssignment]
    request = RequestFactory().get("/dj-admin/core/workgovernanceassignment/")
    request.user = factories.UserFactory(is_staff=True, is_superuser=True)

    assert model_admin.has_view_permission(request)
    assert not model_admin.has_add_permission(request)
    assert not model_admin.has_change_permission(request)
    assert not model_admin.has_delete_permission(request)
