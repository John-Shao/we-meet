"""
API tests for the org admin console: department + membership management.
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _member(org, user, department=None, org_role=models.OrgRoleChoices.MEMBER, **kw):
    return models.Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        org_role=org_role,
        is_primary=kw.pop("is_primary", True),
        **kw,
    )


def _admin_client(org):
    """Return (client, admin_user) where admin_user is an org administrator."""
    admin = factories.UserFactory()
    _member(org, admin, org_role=models.OrgRoleChoices.ADMIN)
    client = APIClient()
    client.force_login(admin)
    return client, admin


def test_admin_departments_create_requires_org_admin():
    """A plain member cannot create departments."""
    org = factories.OrganizationFactory()
    member = factories.UserFactory()
    _member(org, member, org_role=models.OrgRoleChoices.MEMBER)

    client = APIClient()
    client.force_login(member)
    response = client.post(
        "/api/v1.0/admin/departments/", {"name": "Engineering"}, format="json"
    )
    assert response.status_code == 403


def test_admin_departments_create_and_nest():
    """An org admin can create a root department and a child under it."""
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)

    root = client.post(
        "/api/v1.0/admin/departments/", {"name": "Company"}, format="json"
    )
    assert root.status_code == 201, root.content
    root_id = root.json()["id"]

    child = client.post(
        "/api/v1.0/admin/departments/",
        {"name": "Engineering", "parent": root_id},
        format="json",
    )
    assert child.status_code == 201, child.content
    assert child.json()["depth"] == 1
    assert child.json()["path"].startswith(root.json()["path"])


def test_admin_departments_create_rejects_foreign_parent():
    """parent must belong to the caller's organization."""
    org = factories.OrganizationFactory()
    other = factories.OrganizationFactory()
    foreign = models.Department.objects.create(organization=other, name="Foreign")
    client, _ = _admin_client(org)

    response = client.post(
        "/api/v1.0/admin/departments/",
        {"name": "Engineering", "parent": str(foreign.id)},
        format="json",
    )
    assert response.status_code == 400


def test_admin_departments_update_name():
    """Renaming a department is allowed and keeps its team_key stable."""
    org = factories.OrganizationFactory()
    dept = models.Department.objects.create(organization=org, name="Eng")
    original_key = dept.team_key
    client, _ = _admin_client(org)

    response = client.patch(
        f"/api/v1.0/admin/departments/{dept.id}/",
        {"name": "Engineering"},
        format="json",
    )
    assert response.status_code == 200, response.content
    dept.refresh_from_db()
    assert dept.name == "Engineering"
    assert dept.team_key == original_key


def test_admin_departments_soft_delete_blocks_members_without_reassign():
    """Deleting a department with members requires ?reassign."""
    org = factories.OrganizationFactory()
    dept = models.Department.objects.create(organization=org, name="Eng")
    _member(org, factories.UserFactory(), department=dept)
    client, _ = _admin_client(org)

    blocked = client.delete(f"/api/v1.0/admin/departments/{dept.id}/")
    assert blocked.status_code == 400
    dept.refresh_from_db()
    assert dept.deleted_at is None


def test_admin_departments_soft_delete_with_reassign_moves_members():
    """?reassign=<dept> moves members then soft-deletes the department."""
    org = factories.OrganizationFactory()
    dept = models.Department.objects.create(organization=org, name="Eng")
    target = models.Department.objects.create(organization=org, name="Platform")
    moved_user = factories.UserFactory()
    membership = _member(org, moved_user, department=dept)
    client, _ = _admin_client(org)

    response = client.delete(
        f"/api/v1.0/admin/departments/{dept.id}/?reassign={target.id}"
    )
    assert response.status_code == 204, response.content
    dept.refresh_from_db()
    membership.refresh_from_db()
    assert dept.deleted_at is not None
    assert dept.is_active is False
    assert membership.department_id == target.id


def test_admin_memberships_assign_user_to_department_and_change_role():
    """An org admin can place a user in a department and change their role."""
    org = factories.OrganizationFactory()
    dept = models.Department.objects.create(organization=org, name="Eng")
    target_user = factories.UserFactory()
    client, _ = _admin_client(org)

    created = client.post(
        "/api/v1.0/admin/memberships/",
        {
            "user": str(target_user.id),
            "department": str(dept.id),
            "title": "Engineer",
            "org_role": models.OrgRoleChoices.MEMBER,
            "is_primary": True,
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    membership_id = created.json()["id"]

    promoted = client.patch(
        f"/api/v1.0/admin/memberships/{membership_id}/",
        {"org_role": models.OrgRoleChoices.DEPT_ADMIN},
        format="json",
    )
    assert promoted.status_code == 200, promoted.content
    assert promoted.json()["org_role"] == models.OrgRoleChoices.DEPT_ADMIN


def test_admin_memberships_rejects_foreign_department():
    """A membership cannot point at another organization's department."""
    org = factories.OrganizationFactory()
    other = factories.OrganizationFactory()
    foreign_dept = models.Department.objects.create(organization=other, name="Foreign")
    target_user = factories.UserFactory()
    client, _ = _admin_client(org)

    response = client.post(
        "/api/v1.0/admin/memberships/",
        {"user": str(target_user.id), "department": str(foreign_dept.id)},
        format="json",
    )
    assert response.status_code == 400
