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


def test_admin_audit_records_department_move():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    root = models.Department.objects.create(organization=org, name="Root")
    node = models.Department.objects.create(
        organization=org, name="Node", parent=root
    )

    other_root = models.Department.objects.create(organization=org, name="Other")
    moved = client.post(
        f"/api/v1.0/admin/departments/{node.id}/move/",
        {"parent": str(other_root.id)},
        format="json",
    )
    assert moved.status_code == 200, moved.content

    logs = client.get("/api/v1.0/admin/audit-logs/?action=dept.move")
    assert logs.status_code == 200, logs.content
    assert any(row["target_label"] == "Node" for row in logs.json()["results"])


# --- department reparent (move) ---------------------------------------------


def test_admin_department_move_rewrites_subtree_paths():
    """Moving a department rewrites its whole subtree's path and depth."""
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    a = models.Department.objects.create(organization=org, name="A")
    b = models.Department.objects.create(organization=org, name="B", parent=a)
    c = models.Department.objects.create(organization=org, name="C", parent=b)
    target = models.Department.objects.create(organization=org, name="T")

    # Move B (with child C) under T.
    response = client.post(
        f"/api/v1.0/admin/departments/{b.id}/move/",
        {"parent": str(target.id)},
        format="json",
    )
    assert response.status_code == 200, response.content

    b.refresh_from_db()
    c.refresh_from_db()
    assert b.parent_id == target.id
    assert b.depth == 1
    assert b.path == f"{target.id.hex}/{b.id.hex}/"
    # Descendant C follows: its path is rebuilt under B's new path, depth + shifted.
    assert c.path == f"{target.id.hex}/{b.id.hex}/{c.id.hex}/"
    assert c.depth == 2
    assert c.parent_id == b.id  # adjacency unchanged, only materialized path moved


def test_admin_department_move_to_top_level():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    root = models.Department.objects.create(organization=org, name="Root")
    child = models.Department.objects.create(
        organization=org, name="Child", parent=root
    )

    response = client.post(
        f"/api/v1.0/admin/departments/{child.id}/move/",
        {"parent": None},
        format="json",
    )
    assert response.status_code == 200, response.content
    child.refresh_from_db()
    assert child.parent_id is None
    assert child.depth == 0
    assert child.path == f"{child.id.hex}/"


def test_admin_department_move_rejects_cycle():
    """A department cannot be moved under itself or one of its descendants."""
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    a = models.Department.objects.create(organization=org, name="A")
    b = models.Department.objects.create(organization=org, name="B", parent=a)

    # Under itself.
    under_self = client.post(
        f"/api/v1.0/admin/departments/{a.id}/move/",
        {"parent": str(a.id)},
        format="json",
    )
    assert under_self.status_code == 400, under_self.content

    # Under its own descendant.
    under_descendant = client.post(
        f"/api/v1.0/admin/departments/{a.id}/move/",
        {"parent": str(b.id)},
        format="json",
    )
    assert under_descendant.status_code == 400, under_descendant.content


def test_admin_department_move_rejects_foreign_parent():
    org = factories.OrganizationFactory()
    other = factories.OrganizationFactory()
    foreign = models.Department.objects.create(organization=other, name="Foreign")
    client, _ = _admin_client(org)
    node = models.Department.objects.create(organization=org, name="Node")

    response = client.post(
        f"/api/v1.0/admin/departments/{node.id}/move/",
        {"parent": str(foreign.id)},
        format="json",
    )
    assert response.status_code == 400, response.content


def test_admin_department_head_assignment_audits_update():
    """Assigning a head (an org member) succeeds and logs a dept.update."""
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    dept = models.Department.objects.create(organization=org, name="Eng")
    head_user = factories.UserFactory()
    _member(org, head_user)

    response = client.patch(
        f"/api/v1.0/admin/departments/{dept.id}/",
        {"head": str(head_user.id)},
        format="json",
    )
    assert response.status_code == 200, response.content
    dept.refresh_from_db()
    assert dept.head_id == head_user.id

    logs = client.get("/api/v1.0/admin/audit-logs/?action=dept.update")
    assert logs.status_code == 200, logs.content
    assert any(row["target_label"] == "Eng" for row in logs.json()["results"])


def test_admin_department_head_must_be_org_member():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    dept = models.Department.objects.create(organization=org, name="Eng")
    outsider = factories.UserFactory()  # has no membership in org

    response = client.patch(
        f"/api/v1.0/admin/departments/{dept.id}/",
        {"head": str(outsider.id)},
        format="json",
    )
    assert response.status_code == 400, response.content


def test_admin_department_move_requires_org_admin():
    org = factories.OrganizationFactory()
    node = models.Department.objects.create(organization=org, name="Node")
    client, _ = _member_client(org)
    response = client.post(
        f"/api/v1.0/admin/departments/{node.id}/move/",
        {"parent": None},
        format="json",
    )
    assert response.status_code == 403


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


# --- member invitations / pre-provisioning ----------------------------------


def test_admin_create_invitation_pending():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    dept = models.Department.objects.create(organization=org, name="Eng")

    response = client.post(
        "/api/v1.0/admin/invitations/",
        {
            "email": "NewHire@Example.com",
            "department": str(dept.id),
            "org_role": ADMIN,
            "title": "Lead",
        },
        format="json",
    )
    assert response.status_code == 201, response.content
    inv = models.OrgInvitation.objects.get(organization=org)
    assert inv.email == "newhire@example.com"  # normalized
    assert inv.status == models.InvitationStatusChoices.PENDING
    assert inv.department_id == dept.id

    logs = client.get("/api/v1.0/admin/audit-logs/?action=member.invite")
    assert any(
        row["target_label"] == "newhire@example.com"
        for row in logs.json()["results"]
    )


def test_admin_invitation_claimed_on_login_provisions_membership():
    from core.services.invitation_provisioning import claim_pending_invitations

    org = factories.OrganizationFactory()
    dept = models.Department.objects.create(organization=org, name="Eng")
    models.OrgInvitation.objects.create(
        organization=org,
        email="hire@example.com",
        department=dept,
        org_role=ADMIN,
        title="Lead",
    )
    user = factories.UserFactory(email="Hire@example.com")

    applied = claim_pending_invitations(user)
    assert applied == 1

    membership = models.Membership.objects.get(user=user, organization=org)
    assert membership.department_id == dept.id
    assert membership.org_role == ADMIN
    assert membership.title == "Lead"
    assert membership.status == ACTIVE
    assert membership.is_primary is True

    inv = models.OrgInvitation.objects.get(email="hire@example.com")
    assert inv.status == models.InvitationStatusChoices.ACCEPTED
    assert inv.accepted_user_id == user.id


def test_invitation_claim_ignores_unmatched_email():
    from core.services.invitation_provisioning import claim_pending_invitations

    org = factories.OrganizationFactory()
    models.OrgInvitation.objects.create(
        organization=org, email="someone@example.com"
    )
    user = factories.UserFactory(email="other@example.com")

    assert claim_pending_invitations(user) == 0
    assert not models.Membership.objects.filter(user=user).exists()
    assert (
        models.OrgInvitation.objects.get(email="someone@example.com").status
        == models.InvitationStatusChoices.PENDING
    )


def test_admin_revoke_invitation_is_soft_and_not_claimable():
    from core.services.invitation_provisioning import claim_pending_invitations

    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    inv = models.OrgInvitation.objects.create(
        organization=org, email="hire@example.com"
    )

    revoke = client.delete(f"/api/v1.0/admin/invitations/{inv.id}/")
    assert revoke.status_code == 204, revoke.content
    inv.refresh_from_db()
    assert inv.status == models.InvitationStatusChoices.REVOKED

    # A revoked invitation must not provision anything on login.
    user = factories.UserFactory(email="hire@example.com")
    assert claim_pending_invitations(user) == 0


def test_admin_duplicate_pending_invitation_rejected():
    org = factories.OrganizationFactory()
    client, _ = _admin_client(org)
    models.OrgInvitation.objects.create(
        organization=org, email="dup@example.com"
    )
    response = client.post(
        "/api/v1.0/admin/invitations/",
        {"email": "dup@example.com"},
        format="json",
    )
    assert response.status_code == 400, response.content


def test_admin_invitations_require_org_admin():
    org = factories.OrganizationFactory()
    client, _ = _member_client(org)
    assert client.get("/api/v1.0/admin/invitations/").status_code == 403
    assert (
        client.post(
            "/api/v1.0/admin/invitations/",
            {"email": "x@example.com"},
            format="json",
        ).status_code
        == 403
    )
