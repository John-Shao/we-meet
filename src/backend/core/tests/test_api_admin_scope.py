"""Department-scoped administration, end to end (P10 M2).

The design doc calls the bidirectional scope check "最容易漏的越权点", and it is:
filtering the *queryset* is the obvious half and stops a scoped admin touching
someone outside their subtree. The half that gets forgotten is where an edit
**sends** the target — moving a person out of your own scope is functionally
deleting them from the only administrator who was supposed to see them.

These tests exercise a real scoped role holder against the real endpoints, not
the context object in isolation, because the gap only exists at the seam.
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _member(organization, department=None, role=models.OrgRoleChoices.MEMBER):
    user = factories.UserFactory()
    return models.Membership.objects.create(
        organization=organization,
        user=user,
        department=department,
        org_role=role,
        is_primary=True,
    )


@pytest.fixture
def world():
    """An org with Eng (+ a child) and Sales, plus an HR admin scoped to Eng."""
    organization = factories.OrganizationFactory()
    eng = models.Department.objects.create(organization=organization, name="Eng")
    platform = models.Department.objects.create(
        organization=organization, name="Platform", parent=eng
    )
    sales = models.Department.objects.create(organization=organization, name="Sales")

    inside = _member(organization, department=platform)
    outside = _member(organization, department=sales)
    orphan = _member(organization, department=None)

    hr = _member(organization, department=eng)
    role = models.AdminRole.objects.create(
        organization=organization,
        code="hr",
        name="HR",
        permissions=[
            "org.member.read",
            "org.member.write",
            "org.department.read",
            "org.department.write",
        ],
    )
    assignment = models.AdminRoleAssignment.objects.create(
        role=role, membership=hr, scope_type=models.AdminScopeChoices.DEPARTMENTS
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=assignment, department=eng
    )
    return {
        "organization": organization,
        "eng": eng,
        "platform": platform,
        "sales": sales,
        "inside": inside,
        "outside": outside,
        "orphan": orphan,
        "hr": hr,
    }


# --- reads -----------------------------------------------------------------


def test_a_scoped_admin_can_reach_member_management_at_all(world):
    """Before M2 this was a flat 403: the gate was org_role, not permissions."""
    response = _client(world["hr"].user).get("/api/v1.0/admin/memberships/")
    assert response.status_code == 200


def test_the_member_list_shows_only_the_subtree(world):
    response = _client(world["hr"].user).get("/api/v1.0/admin/memberships/")
    ids = {row["id"] for row in response.data["results"]}

    assert str(world["inside"].id) in ids  # a child department counts
    assert str(world["outside"].id) not in ids
    # Someone in no department is not "inside Engineering" by any reading.
    assert str(world["orphan"].id) not in ids


def test_a_member_outside_the_scope_is_not_even_addressable(world):
    """404 via the queryset, not an unguarded write reached and then refused."""
    response = _client(world["hr"].user).patch(
        f"/api/v1.0/admin/memberships/{world['outside'].id}/",
        {"title": "偷改的职位"},
        format="json",
    )
    assert response.status_code == 404
    world["outside"].refresh_from_db()
    assert world["outside"].title != "偷改的职位"


# --- the bidirectional check ----------------------------------------------


def test_editing_within_the_scope_works(world):
    response = _client(world["hr"].user).patch(
        f"/api/v1.0/admin/memberships/{world['inside'].id}/",
        {"title": "高级工程师"},
        format="json",
    )
    assert response.status_code == 200, response.data
    world["inside"].refresh_from_db()
    assert world["inside"].title == "高级工程师"


def test_cannot_move_a_member_out_of_the_scope(world):
    """The forgotten half. Moving them out = deleting them from your console."""
    response = _client(world["hr"].user).patch(
        f"/api/v1.0/admin/memberships/{world['inside'].id}/",
        {"department": str(world["sales"].id)},
        format="json",
    )
    assert response.status_code == 403
    world["inside"].refresh_from_db()
    assert world["inside"].department_id == world["platform"].id


def test_cannot_move_a_member_to_the_org_root_either(world):
    """department=null is org level — outside any department scope."""
    response = _client(world["hr"].user).patch(
        f"/api/v1.0/admin/memberships/{world['inside'].id}/",
        {"department": None},
        format="json",
    )
    assert response.status_code == 403


def test_moving_within_the_subtree_is_allowed(world):
    response = _client(world["hr"].user).patch(
        f"/api/v1.0/admin/memberships/{world['inside'].id}/",
        {"department": str(world["eng"].id)},
        format="json",
    )
    assert response.status_code == 200, response.data


def test_bulk_move_out_of_scope_is_refused(world):
    """A bulk endpoint is exactly where a scope hole gets exploited at scale."""
    response = _client(world["hr"].user).post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {"ids": [str(world["inside"].id)], "department": str(world["sales"].id)},
        format="json",
    )
    assert response.status_code == 403
    world["inside"].refresh_from_db()
    assert world["inside"].department_id == world["platform"].id


def test_bulk_move_silently_ignores_targets_outside_the_scope(world):
    """`_bulk_targets` goes through get_queryset(), so out-of-scope ids resolve to nothing."""
    response = _client(world["hr"].user).post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {
            "ids": [str(world["inside"].id), str(world["outside"].id)],
            "department": str(world["eng"].id),
        },
        format="json",
    )
    assert response.status_code == 200, response.data
    assert response.data["moved"] == 1
    world["outside"].refresh_from_db()
    assert world["outside"].department_id == world["sales"].id


# --- departments -----------------------------------------------------------


def test_scoped_admin_creates_only_inside_their_subtree(world):
    client = _client(world["hr"].user)

    ok = client.post(
        "/api/v1.0/admin/departments/",
        {"name": "新组", "parent": str(world["eng"].id)},
        format="json",
    )
    assert ok.status_code == 201, ok.data

    outside = client.post(
        "/api/v1.0/admin/departments/",
        {"name": "别人家的组", "parent": str(world["sales"].id)},
        format="json",
    )
    assert outside.status_code == 403


def test_scoped_admin_cannot_create_a_root_department(world):
    """A root node is org-wide by definition — not inside anyone's subtree."""
    response = _client(world["hr"].user).post(
        "/api/v1.0/admin/departments/", {"name": "新一级部门"}, format="json"
    )
    assert response.status_code == 403


def test_scoped_admin_cannot_rename_a_department_outside_the_scope(world):
    response = _client(world["hr"].user).patch(
        f"/api/v1.0/admin/departments/{world['sales'].id}/",
        {"name": "改名了"},
        format="json",
    )
    assert response.status_code == 404


# --- separable grants ------------------------------------------------------


def test_member_write_does_not_imply_offboard(world):
    """Offboarding touches Keycloak and resource ownership — a separate grant."""
    response = _client(world["hr"].user).post(
        f"/api/v1.0/admin/memberships/{world['inside'].id}/offboard/",
        {},
        format="json",
    )
    assert response.status_code == 403


def test_offboard_works_once_the_permission_is_granted(world):
    role = models.AdminRole.objects.get(organization=world["organization"], code="hr")
    role.permissions = [*role.permissions, "org.member.offboard"]
    role.save()

    response = _client(world["hr"].user).post(
        f"/api/v1.0/admin/memberships/{world['inside'].id}/offboard/",
        {},
        format="json",
    )
    assert response.status_code == 200, response.data


# --- the unscoped case must be untouched -----------------------------------


def test_an_org_administrator_is_unaffected_by_any_of_this(world):
    """M2 must not narrow what already worked."""
    owner = _member(world["organization"], role=models.OrgRoleChoices.OWNER)
    client = _client(owner.user)

    listing = client.get("/api/v1.0/admin/memberships/")
    ids = {row["id"] for row in listing.data["results"]}
    assert str(world["outside"].id) in ids
    assert str(world["orphan"].id) in ids

    moved = client.patch(
        f"/api/v1.0/admin/memberships/{world['inside'].id}/",
        {"department": str(world["sales"].id)},
        format="json",
    )
    assert moved.status_code == 200, moved.data

    root = client.post(
        "/api/v1.0/admin/departments/", {"name": "新一级部门"}, format="json"
    )
    assert root.status_code == 201, root.data
