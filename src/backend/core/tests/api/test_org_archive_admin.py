"""Archived-organization admin surface tests (P0-4)."""

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import organization_lifecycle

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
OWNER = models.OrgRoleChoices.OWNER
MEMBER = models.OrgRoleChoices.MEMBER

ROOT = "/api/v1.0"


def _member(org, user=None, *, role=MEMBER):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        org_role=role,
        status=ACTIVE,
        is_primary=True,
    )


def _client_for(membership):
    client = APIClient()
    client.force_login(membership.user)
    return client


@pytest.fixture
def org():
    return factories.OrganizationFactory()


@pytest.fixture
def owner(org):
    return _member(org, role=OWNER)


def test_directory_me_reports_organization_state(org, owner):
    client = _client_for(owner)
    body = client.get(f"{ROOT}/directory/me/").json()
    assert body["organization"]["state"] == "active"
    assert body["is_org_admin"] is True

    organization_lifecycle.suspend(org, actor=owner.user)
    body = client.get(f"{ROOT}/directory/me/").json()
    assert body["organization"]["state"] == "suspended"
    assert body["is_org_admin"] is False
    assert body["permissions"] == []

    organization_lifecycle.activate(org, actor=owner.user)
    organization_lifecycle.archive(org, actor=owner.user)
    body = client.get(f"{ROOT}/directory/me/").json()
    assert body["organization"]["state"] == "archived"
    assert body["is_org_admin"] is False
    # The console still needs its permission set to render the read-only UI.
    assert "org.member.write" in body["permissions"]


def test_archived_organization_admin_api_is_read_only(org, owner):
    organization_lifecycle.archive(org, actor=owner.user)
    client = _client_for(owner)

    listed = client.get(f"{ROOT}/admin/memberships/")
    assert listed.status_code == 200, listed.content

    created = client.post(
        f"{ROOT}/admin/departments/", {"name": "Engineering"}, format="json"
    )
    assert created.status_code == 403
    assert created.json() == {"code": "organization_read_only"}

    member = _member(org)
    patched = client.patch(
        f"{ROOT}/admin/memberships/{member.id}/",
        {"title": "Engineer"},
        format="json",
    )
    assert patched.status_code == 403
    assert patched.json() == {"code": "organization_read_only"}


def test_suspended_organization_grants_no_admin_api(org, owner):
    organization_lifecycle.suspend(org, actor=owner.user)
    client = _client_for(owner)

    assert client.get(f"{ROOT}/admin/memberships/").status_code == 403
    created = client.post(
        f"{ROOT}/admin/departments/", {"name": "Engineering"}, format="json"
    )
    assert created.status_code == 403
    assert created.json() != {"code": "organization_read_only"}


def test_suspended_organization_revokes_custom_role_permissions(org, owner):
    """A custom role is not a side door into a suspended tenant."""
    holder = _member(org)
    role = models.AdminRole.objects.create(
        organization=org,
        code="hr",
        name="HR",
        permissions=["org.member.read", "org.member.write"],
    )
    models.AdminRoleAssignment.objects.create(
        role=role,
        membership=holder,
        scope_type=models.AdminScopeChoices.ALL,
    )

    client = _client_for(holder)
    assert client.get(f"{ROOT}/admin/memberships/").status_code == 200

    organization_lifecycle.suspend(org, actor=owner.user)

    assert client.get(f"{ROOT}/admin/memberships/").status_code == 403
    body = client.get(f"{ROOT}/directory/me/").json()
    assert body["organization"]["state"] == "suspended"
    assert body["is_org_admin"] is False
    assert body["permissions"] == []


def test_archived_organization_cannot_be_modified_by_core_admin(org, owner):
    organization_lifecycle.archive(org, actor=owner.user)
    org.refresh_from_db()

    assert not models.Organization.objects.filter(pk=org.pk, is_active=True).exists()
    # No customer-facing endpoint accepts these fields at all; the only writer
    # of archived_at / is_active is the lifecycle service.
    client = _client_for(owner)
    response = client.patch(
        f"{ROOT}/admin/organization/",
        {"is_active": True, "archived_at": None},
        format="json",
    )
    assert response.status_code in (404, 405)
    org.refresh_from_db()
    assert org.is_active is False
    assert org.archived_at is not None
