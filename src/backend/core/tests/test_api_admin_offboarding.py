"""API tests for member offboarding / rehire / purge (P10 M1).

The core claim under test: flipping a membership to ``LEFT`` is enough to make
the person disappear everywhere, because the directory, ``get_teams()`` and
``get_caller_organization`` all already filter on ``status=ACTIVE``.
"""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
LEFT = models.MembershipStatusChoices.LEFT
MEMBER = models.OrgRoleChoices.MEMBER
ADMIN = models.OrgRoleChoices.ADMIN
OWNER = models.OrgRoleChoices.OWNER

# The Keycloak call is fired via transaction.on_commit → task; patch the task so
# tests never reach out to an identity provider.
PATCH_DISABLE = "core.tasks.offboarding.disable_keycloak_login"
PATCH_ENABLE = "core.tasks.offboarding.enable_keycloak_login"


def _member(org, user=None, **kw):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        is_primary=kw.pop("is_primary", True),
        **kw,
    )


def _admin_client(org, org_role=ADMIN):
    admin = factories.UserFactory()
    _member(org, admin, org_role=org_role)
    client = APIClient()
    client.force_login(admin)
    return client, admin


def _offboard(client, membership, **body):
    with mock.patch(PATCH_DISABLE):
        return client.post(
            f"/api/v1.0/admin/memberships/{membership.id}/offboard/",
            body,
            format="json",
        )


# --- happy path --------------------------------------------------------------


def test_offboard_marks_left_and_freezes_snapshot():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    department = models.Department.objects.create(organization=org, name="研发部")
    target = _member(org, department=department, title="Engineer", employee_no="E7")

    response = _offboard(client, target, reason="resigned")
    assert response.status_code == 200, response.content

    target.refresh_from_db()
    assert target.status == LEFT
    assert target.left_at is not None
    assert target.left_reason == "resigned"
    assert target.left_snapshot["department_name"] == "研发部"
    assert target.left_snapshot["title"] == "Engineer"
    # is_primary must be cleared or the partial unique constraint blocks rehire.
    assert target.is_primary is False


def test_offboard_removes_member_from_directory():
    """The whole point: one status flag, and they are gone from the directory."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org)

    listed = client.get("/api/v1.0/directory/members/").json()["results"]
    assert str(target.user_id) in [row["id"] for row in listed]

    _offboard(client, target)

    listed = client.get("/api/v1.0/directory/members/").json()["results"]
    assert str(target.user_id) not in [row["id"] for row in listed]


def test_offboard_drops_team_based_resource_access():
    """Department-shared recordings must stop being reachable immediately."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    department = models.Department.objects.create(organization=org, name="Eng")
    target = _member(org, department=department)

    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, team=department.team_key, role=models.RoleChoices.MEMBER
    )

    user = models.User.objects.get(pk=target.user_id)
    assert department.team_key in user.get_teams()
    assert models.RecordingAccess.objects.filter_user(user).exists()

    _offboard(client, target)

    fresh = models.User.objects.get(pk=target.user_id)  # drop the memoized cache
    assert fresh.get_teams() == []
    assert not models.RecordingAccess.objects.filter_user(fresh).exists()


def test_offboard_schedules_keycloak_disable(django_capture_on_commit_callbacks):
    """The disable fires on commit, so the test must run the callbacks itself."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org, user=factories.UserFactory(sub="kc-sub-1"))

    with mock.patch(PATCH_DISABLE) as disable:
        with django_capture_on_commit_callbacks(execute=True):
            response = client.post(
                f"/api/v1.0/admin/memberships/{target.id}/offboard/", {}, format="json"
            )
        assert response.status_code == 200, response.content
    disable.delay.assert_called_once()


def test_offboard_can_skip_login_disable(django_capture_on_commit_callbacks):
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org, user=factories.UserFactory(sub="kc-sub-2"))

    with mock.patch(PATCH_DISABLE) as disable:
        with django_capture_on_commit_callbacks(execute=True):
            client.post(
                f"/api/v1.0/admin/memberships/{target.id}/offboard/",
                {"disable_login": False},
                format="json",
            )
    disable.delay.assert_not_called()


def test_offboard_without_sub_skips_keycloak(django_capture_on_commit_callbacks):
    """Users who never went through OIDC have no Keycloak account to disable."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org, user=factories.UserFactory(sub=None))

    with mock.patch(PATCH_DISABLE) as disable:
        with django_capture_on_commit_callbacks(execute=True):
            client.post(
                f"/api/v1.0/admin/memberships/{target.id}/offboard/", {}, format="json"
            )
    disable.delay.assert_not_called()


def test_keycloak_failure_does_not_undo_offboarding(
    django_capture_on_commit_callbacks,
):
    """A Keycloak outage must not roll back an offboarding that already committed."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org, user=factories.UserFactory(sub="kc-sub-3"))

    with mock.patch(PATCH_DISABLE) as disable:
        disable.delay.side_effect = RuntimeError("broker down")
        with django_capture_on_commit_callbacks(execute=True):
            response = client.post(
                f"/api/v1.0/admin/memberships/{target.id}/offboard/", {}, format="json"
            )
        assert response.status_code == 200, response.content

    target.refresh_from_db()
    assert target.status == LEFT


# --- guards ------------------------------------------------------------------


def test_cannot_offboard_yourself():
    org = factories.OrganizationFactory()
    client, admin = _admin_client(org)
    own = models.Membership.objects.get(user=admin, organization=org)

    response = _offboard(client, own)
    assert response.status_code == 400
    assert "yourself" in str(response.content).lower()


def test_cannot_offboard_last_active_owner():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org, org_role=OWNER)
    # A second owner so the admin client itself isn't the last one…
    victim = _member(org, org_role=OWNER, is_primary=True)
    # …then remove the caller's own owner status so `victim` becomes the last.
    models.Membership.objects.filter(organization=org).exclude(id=victim.id).update(
        org_role=ADMIN
    )

    response = _offboard(client, victim)
    assert response.status_code == 400
    assert "owner" in str(response.content).lower()


def test_offboarding_a_department_head_requires_a_decision():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    head_user = factories.UserFactory()
    target = _member(org, user=head_user)
    department = models.Department.objects.create(
        organization=org, name="Eng", head=head_user
    )

    # Neither a replacement nor an explicit opt-out → refused.
    response = _offboard(client, target)
    assert response.status_code == 400
    assert "transfer_head_to" in response.json()

    # Explicit opt-out is accepted and leaves the department headless.
    response = _offboard(client, target, allow_orphan_head=True)
    assert response.status_code == 200, response.content
    department.refresh_from_db()
    assert department.head_id is None


def test_offboarding_head_transfers_to_replacement():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    head_user = factories.UserFactory()
    target = _member(org, user=head_user)
    successor = _member(org)
    department = models.Department.objects.create(
        organization=org, name="Eng", head=head_user
    )

    response = _offboard(client, target, transfer_head_to=str(successor.id))
    assert response.status_code == 200, response.content
    department.refresh_from_db()
    assert department.head_id == successor.user_id


def test_offboarding_clears_direct_reports():
    """Nobody may keep a leaver as their manager — approval routing would break."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    boss = _member(org)
    report = _member(org, manager=boss)

    response = _offboard(client, boss)
    assert response.status_code == 200, response.content
    assert response.json()["reports_cleared"] == 1
    report.refresh_from_db()
    assert report.manager_id is None


def test_offboard_twice_is_rejected():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org)

    assert _offboard(client, target).status_code == 200
    assert _offboard(client, target).status_code == 400


def test_plain_member_cannot_offboard():
    org = factories.OrganizationFactory()
    target = _member(org)
    plain = factories.UserFactory()
    _member(org, plain, org_role=MEMBER)
    client = APIClient()
    client.force_login(plain)

    response = client.post(
        f"/api/v1.0/admin/memberships/{target.id}/offboard/", {}, format="json"
    )
    assert response.status_code == 403


# --- owned resources ---------------------------------------------------------


def test_owned_resources_reports_what_would_be_orphaned():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    head_user = factories.UserFactory()
    target = _member(org, user=head_user)
    models.Department.objects.create(organization=org, name="Eng", head=head_user)
    _member(org, manager=target)

    response = client.get(
        f"/api/v1.0/admin/memberships/{target.id}/owned-resources/"
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert len(body["headed_departments"]) == 1
    assert body["direct_reports_count"] == 1


# --- rehire ------------------------------------------------------------------


def test_rehire_restores_the_same_row():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    department = models.Department.objects.create(organization=org, name="Eng")
    target = _member(org, department=department)
    membership_id = target.id

    _offboard(client, target)

    with mock.patch(PATCH_ENABLE):
        response = client.post(
            f"/api/v1.0/admin/memberships/{membership_id}/rehire/", {}, format="json"
        )
    assert response.status_code == 200, response.content

    target.refresh_from_db()
    assert target.status == ACTIVE
    assert target.left_at is None
    assert target.left_snapshot == {}
    assert target.is_primary is True
    # Crucially: no duplicate row was created for the same (user, department).
    assert (
        models.Membership.objects.filter(
            user=target.user, department=department
        ).count()
        == 1
    )


def test_rehire_into_the_same_department_does_not_violate_uniqueness():
    """The regression this design exists to prevent (P10 risk R7)."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    department = models.Department.objects.create(organization=org, name="Eng")
    target = _member(org, department=department)

    _offboard(client, target)
    with mock.patch(PATCH_ENABLE):
        response = client.post(
            f"/api/v1.0/admin/memberships/{target.id}/rehire/",
            {"department": str(department.id)},
            format="json",
        )
    assert response.status_code == 200, response.content


def test_rehire_rejects_active_member():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org)

    response = client.post(
        f"/api/v1.0/admin/memberships/{target.id}/rehire/", {}, format="json"
    )
    assert response.status_code == 400


# --- purge -------------------------------------------------------------------


def test_purge_only_after_leaving():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org)

    assert (
        client.delete(f"/api/v1.0/admin/memberships/{target.id}/purge/").status_code
        == 400
    )

    _offboard(client, target)
    assert (
        client.delete(f"/api/v1.0/admin/memberships/{target.id}/purge/").status_code
        == 204
    )
    assert not models.Membership.objects.filter(id=target.id).exists()


def test_purge_writes_audit():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org)
    _offboard(client, target)
    client.delete(f"/api/v1.0/admin/memberships/{target.id}/purge/")

    assert models.AuditLog.objects.filter(
        organization=org, action=models.AuditActionChoices.MEMBER_PURGE
    ).exists()


# --- offboarded list ---------------------------------------------------------


def test_left_members_listed_with_days_and_snapshot():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    department = models.Department.objects.create(organization=org, name="研发部")
    target = _member(org, department=department)
    _offboard(client, target)

    response = client.get("/api/v1.0/admin/memberships/?status=left")
    assert response.status_code == 200, response.content
    rows = response.json()["results"]
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == LEFT
    assert row["left_days"] == 0
    assert row["left_snapshot"]["department_name"] == "研发部"


def test_left_members_filterable_by_date_range():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target = _member(org)
    _offboard(client, target, left_at="2026-03-15T00:00:00Z")

    hit = client.get(
        "/api/v1.0/admin/memberships/?status=left"
        "&left_after=2026-03-01T00:00:00Z&left_before=2026-04-01T00:00:00Z"
    ).json()["results"]
    assert len(hit) == 1

    miss = client.get(
        "/api/v1.0/admin/memberships/?status=left&left_after=2026-05-01T00:00:00Z"
    ).json()["results"]
    assert miss == []
