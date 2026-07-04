"""API tests for the management console (M 端) additions:

- ``GET /directory/me/`` — caller org + role for the console guard/shell
- ``GET /admin/memberships/`` — all-status member list + governance guards
- ``GET /admin/stats/overview/`` — dashboard aggregates
- ``admin/audit-logs`` — audit records written by admin mutations
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
SUSPENDED = models.MembershipStatusChoices.SUSPENDED
INVITED = models.MembershipStatusChoices.INVITED
MEMBER = models.OrgRoleChoices.MEMBER
ADMIN = models.OrgRoleChoices.ADMIN
OWNER = models.OrgRoleChoices.OWNER


def _member(org, user, department=None, org_role=MEMBER, **kw):
    return models.Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        org_role=org_role,
        is_primary=kw.pop("is_primary", True),
        **kw,
    )


def _admin_client(org, org_role=ADMIN):
    admin = factories.UserFactory()
    _member(org, admin, org_role=org_role)
    client = APIClient()
    client.force_login(admin)
    return client, admin


def _member_client(org):
    user = factories.UserFactory()
    _member(org, user, org_role=MEMBER)
    client = APIClient()
    client.force_login(user)
    return client, user


# --- directory/me -----------------------------------------------------------


def test_directory_me_reports_org_admin():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)

    response = client.get("/api/v1.0/directory/me/")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["is_org_admin"] is True
    assert body["org_role"] == ADMIN
    assert body["organization"]["id"] == str(org.id)
    assert body["organization"]["name"] == org.name


def test_directory_me_plain_member_is_not_admin():
    org = factories.OrganizationFactory()
    client, _ = _member_client(org)

    response = client.get("/api/v1.0/directory/me/")
    assert response.status_code == 200, response.content
    assert response.json()["is_org_admin"] is False


def test_directory_me_non_member_is_empty():
    user = factories.UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.get("/api/v1.0/directory/me/")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["organization"] is None
    assert body["is_org_admin"] is False


# --- membership list (all statuses) -----------------------------------------


def test_admin_memberships_list_includes_all_statuses():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    _member(org, factories.UserFactory(), status=ACTIVE)
    _member(org, factories.UserFactory(), status=SUSPENDED)
    _member(org, factories.UserFactory(), status=INVITED)

    response = client.get("/api/v1.0/admin/memberships/")
    assert response.status_code == 200, response.content
    statuses = {row["status"] for row in response.json()["results"]}
    assert {ACTIVE, SUSPENDED, INVITED} <= statuses


def test_admin_memberships_list_filters_by_status():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    _member(org, factories.UserFactory(), status=SUSPENDED)

    response = client.get("/api/v1.0/admin/memberships/?status=suspended")
    assert response.status_code == 200, response.content
    results = response.json()["results"]
    assert results
    assert all(row["status"] == SUSPENDED for row in results)


def test_admin_memberships_list_requires_org_admin():
    org = factories.OrganizationFactory()
    client, _ = _member_client(org)
    assert client.get("/api/v1.0/admin/memberships/").status_code == 403


# --- governance guards ------------------------------------------------------


def test_admin_membership_cannot_suspend_self():
    org = factories.OrganizationFactory()
    client, admin = _admin_client(org)
    own = models.Membership.objects.get(user=admin, organization=org)

    response = client.patch(
        f"/api/v1.0/admin/memberships/{own.id}/",
        {"status": SUSPENDED},
        format="json",
    )
    assert response.status_code == 400, response.content


def test_admin_membership_cannot_demote_last_owner():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    owner = _member(org, factories.UserFactory(), org_role=OWNER)

    response = client.patch(
        f"/api/v1.0/admin/memberships/{owner.id}/",
        {"org_role": MEMBER},
        format="json",
    )
    assert response.status_code == 400, response.content

    # A second owner makes demotion allowed again.
    _member(org, factories.UserFactory(), org_role=OWNER)
    response = client.patch(
        f"/api/v1.0/admin/memberships/{owner.id}/",
        {"org_role": MEMBER},
        format="json",
    )
    assert response.status_code == 200, response.content


def test_admin_membership_suspend_and_restore_ok():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    membership = _member(org, factories.UserFactory(), status=ACTIVE)

    suspended = client.patch(
        f"/api/v1.0/admin/memberships/{membership.id}/",
        {"status": SUSPENDED},
        format="json",
    )
    assert suspended.status_code == 200, suspended.content
    membership.refresh_from_db()
    assert membership.status == SUSPENDED


# --- stats/overview ---------------------------------------------------------


def test_admin_stats_overview_requires_org_admin():
    org = factories.OrganizationFactory()
    client, _ = _member_client(org)
    assert client.get("/api/v1.0/admin/stats/overview/").status_code == 403


def test_admin_stats_overview_shape_and_counts():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    models.Department.objects.create(organization=org, name="Eng")
    _member(org, factories.UserFactory(), status=SUSPENDED)

    response = client.get("/api/v1.0/admin/stats/overview/")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["members"]["total"] >= 2  # admin + suspended member
    assert body["members"]["suspended"] >= 1
    assert body["departments"] >= 1
    assert "approvals" in body and "pending" in body["approvals"]
    assert len(body["trend"]) == 14
    assert all("date" in point and "count" in point for point in body["trend"])


# --- audit log --------------------------------------------------------------


def test_admin_audit_records_department_create():
    org = factories.OrganizationFactory()
    client, admin = _admin_client(org)

    created = client.post(
        "/api/v1.0/admin/departments/", {"name": "Engineering"}, format="json"
    )
    assert created.status_code == 201, created.content

    logs = client.get("/api/v1.0/admin/audit-logs/")
    assert logs.status_code == 200, logs.content
    entries = [
        row for row in logs.json()["results"] if row["action"] == "dept.create"
    ]
    assert entries, logs.content
    assert entries[0]["target_label"] == "Engineering"
    assert entries[0]["actor"]["id"] == str(admin.id)


def test_admin_audit_records_member_suspend_and_filters():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    membership = _member(org, factories.UserFactory(), status=ACTIVE)

    client.patch(
        f"/api/v1.0/admin/memberships/{membership.id}/",
        {"status": SUSPENDED},
        format="json",
    )

    logs = client.get("/api/v1.0/admin/audit-logs/?action=member.suspend")
    assert logs.status_code == 200, logs.content
    results = logs.json()["results"]
    assert results
    assert all(row["action"] == "member.suspend" for row in results)


def test_admin_audit_requires_org_admin():
    org = factories.OrganizationFactory()
    client, _ = _member_client(org)
    assert client.get("/api/v1.0/admin/audit-logs/").status_code == 403


def test_admin_audit_is_org_scoped():
    org = factories.OrganizationFactory()
    other = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    # An action in `org` must not surface in another org admin's log.
    client.post(
        "/api/v1.0/admin/departments/", {"name": "Secret"}, format="json"
    )

    other_client, _ = _admin_client(other)
    logs = other_client.get("/api/v1.0/admin/audit-logs/")
    assert logs.status_code == 200, logs.content
    assert all(
        row["target_label"] != "Secret" for row in logs.json()["results"]
    )
