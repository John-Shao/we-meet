"""User groups as ACL subjects — admin CRUD, get_teams(), and the team write path.

The point of a group is not "a saved selection of people": it is a subject that
``BaseAccess.team`` can name. So these tests care less about CRUD shape and more
about the three things that make it real —

1. ``get_teams()`` returns the group key, so team-aware querysets light up.
2. There is finally a write path that can *create* a team grant.
3. That write path cannot be talked into creating a grant that reaches nobody
   (typo'd prefix), reaches another organization, or points at a dead subject.
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
OWNER = models.RoleChoices.OWNER
MEMBER = models.RoleChoices.MEMBER


def _org_with_admin():
    organization = factories.OrganizationFactory()
    admin = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=admin,
        org_role=models.OrgRoleChoices.ADMIN,
        is_primary=True,
    )
    return organization, admin


def _member(organization, department=None):
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization, user=user, department=department, is_primary=True
    )
    return user


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


# --- get_teams(): the whole reason the model exists ------------------------


def test_get_teams_includes_group_keys():
    organization, _admin = _org_with_admin()
    user = _member(organization)
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    models.UserGroupMember.objects.create(group=group, user=user)

    assert group.group_key.startswith("group:")
    assert group.group_key in user.get_teams()


def test_get_teams_returns_both_departments_and_groups():
    organization, _admin = _org_with_admin()
    department = models.Department.objects.create(organization=organization, name="Eng")
    user = _member(organization, department=department)
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    models.UserGroupMember.objects.create(group=group, user=user)

    assert set(user.get_teams()) == {department.team_key, group.group_key}


def test_get_teams_skips_deleted_and_inactive_groups():
    organization, _admin = _org_with_admin()
    user = _member(organization)
    dead = models.UserGroup.objects.create(organization=organization, name="旧组")
    off = models.UserGroup.objects.create(
        organization=organization, name="停用组", is_active=False
    )
    models.UserGroupMember.objects.create(group=dead, user=user)
    models.UserGroupMember.objects.create(group=off, user=user)
    dead.deleted_at = "2026-01-01T00:00:00Z"
    dead.save()

    assert user.get_teams() == []


def test_group_grant_reaches_a_recording():
    """The P1 promise, now reachable through a group instead of a department."""
    organization, _admin = _org_with_admin()
    user = _member(organization)
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    models.UserGroupMember.objects.create(group=group, user=user)

    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, team=group.group_key, role=MEMBER
    )

    assert models.get_resource_roles(recording, user) == [MEMBER]


def test_removing_someone_from_a_group_revokes_the_grant():
    """Team grants follow live membership — that is why they are not expanded."""
    organization, _admin = _org_with_admin()
    user = _member(organization)
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    row = models.UserGroupMember.objects.create(group=group, user=user)

    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, team=group.group_key, role=MEMBER
    )
    assert models.get_resource_roles(recording, user) == [MEMBER]

    row.delete()
    fresh = models.User.objects.get(pk=user.pk)  # drop the memoized _teams_cache
    assert models.get_resource_roles(recording, fresh) == []


# --- admin CRUD ------------------------------------------------------------


def test_admin_creates_a_group_and_gets_its_key_back():
    organization, admin = _org_with_admin()
    response = _client(admin).post(
        "/api/v1.0/admin/user-groups/", {"name": "值班组"}, format="json"
    )
    assert response.status_code == 201, response.data
    assert response.data["group_key"].startswith("group:")
    assert response.data["member_count"] == 0


def test_plain_member_cannot_create_a_group():
    organization, _admin = _org_with_admin()
    user = _member(organization)
    response = _client(user).post(
        "/api/v1.0/admin/user-groups/", {"name": "值班组"}, format="json"
    )
    assert response.status_code == 403


def test_group_names_are_unique_within_an_organization():
    organization, admin = _org_with_admin()
    models.UserGroup.objects.create(organization=organization, name="值班组")
    response = _client(admin).post(
        "/api/v1.0/admin/user-groups/", {"name": "值班组"}, format="json"
    )
    assert response.status_code == 400


def test_add_members_is_idempotent_and_reports_what_it_skipped():
    organization, admin = _org_with_admin()
    inside = _member(organization)
    outsider = factories.UserFactory()  # no membership here
    group = models.UserGroup.objects.create(organization=organization, name="值班组")

    url = f"/api/v1.0/admin/user-groups/{group.id}/add-members/"
    first = _client(admin).post(
        url, {"user_ids": [str(inside.id), str(outsider.id)]}, format="json"
    )
    assert first.status_code == 200, first.data
    assert first.data == {"added": 1, "already_member": 0, "skipped": 1}

    second = _client(admin).post(url, {"user_ids": [str(inside.id)]}, format="json")
    assert second.data["added"] == 0
    assert second.data["already_member"] == 1
    assert models.UserGroupMember.objects.filter(group=group).count() == 1


def test_remove_member():
    organization, admin = _org_with_admin()
    user = _member(organization)
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    models.UserGroupMember.objects.create(group=group, user=user)

    response = _client(admin).post(
        f"/api/v1.0/admin/user-groups/{group.id}/remove-member/",
        {"user_id": str(user.id)},
        format="json",
    )
    assert response.status_code == 200
    assert not models.UserGroupMember.objects.filter(group=group).exists()


def test_delete_is_soft_so_orphan_grants_stay_visible():
    organization, admin = _org_with_admin()
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, team=group.group_key, role=MEMBER
    )

    response = _client(admin).delete(f"/api/v1.0/admin/user-groups/{group.id}/")
    assert response.status_code == 204

    group.refresh_from_db()
    assert group.deleted_at is not None
    # The grant row survives — it just stops resolving.
    assert models.RecordingAccess.objects.filter(team=group.group_key).exists()

    audit = models.AuditLog.objects.filter(
        action=models.AuditActionChoices.GROUP_DELETE
    ).first()
    assert audit is not None
    assert audit.metadata["revoked_grants"] == 1


def test_group_list_is_scoped_to_the_callers_organization():
    organization, admin = _org_with_admin()
    other = factories.OrganizationFactory()
    models.UserGroup.objects.create(organization=organization, name="我的组")
    models.UserGroup.objects.create(organization=other, name="别人的组")

    response = _client(admin).get("/api/v1.0/admin/user-groups/")
    assert [g["name"] for g in response.data] == ["我的组"]


# --- the team write path ---------------------------------------------------


def _owned_recording(user):
    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(recording=recording, user=user, role=OWNER)
    return recording


def test_owner_can_share_a_recording_with_a_group():
    organization, admin = _org_with_admin()
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    recording = _owned_recording(admin)

    response = _client(admin).post(
        "/api/v1.0/recording-accesses/",
        {
            "recording": str(recording.id),
            "team": group.group_key,
            "role": MEMBER,
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["subject_kind"] == "group"
    assert response.data["team_label"] == "值班组"


def test_owner_can_share_a_recording_with_a_department():
    organization, admin = _org_with_admin()
    department = models.Department.objects.create(organization=organization, name="Eng")
    recording = _owned_recording(admin)

    response = _client(admin).post(
        "/api/v1.0/recording-accesses/",
        {
            "recording": str(recording.id),
            "team": department.team_key,
            "role": MEMBER,
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["subject_kind"] == "dept"
    assert response.data["team_label"] == "Eng"


def test_a_typo_prefix_is_rejected_rather_than_stored_as_a_dead_grant():
    _organization, admin = _org_with_admin()
    recording = _owned_recording(admin)

    response = _client(admin).post(
        "/api/v1.0/recording-accesses/",
        {"recording": str(recording.id), "team": "dep:abc", "role": MEMBER},
        format="json",
    )
    assert response.status_code == 400
    assert "team" in response.data


def test_cannot_share_with_another_organizations_group():
    _organization, admin = _org_with_admin()
    other = factories.OrganizationFactory()
    foreign = models.UserGroup.objects.create(organization=other, name="别家的组")
    recording = _owned_recording(admin)

    response = _client(admin).post(
        "/api/v1.0/recording-accesses/",
        {"recording": str(recording.id), "team": foreign.group_key, "role": MEMBER},
        format="json",
    )
    assert response.status_code == 400


def test_cannot_share_with_a_deleted_group():
    organization, admin = _org_with_admin()
    group = models.UserGroup.objects.create(organization=organization, name="旧组")
    group.deleted_at = "2026-01-01T00:00:00Z"
    group.save()
    recording = _owned_recording(admin)

    response = _client(admin).post(
        "/api/v1.0/recording-accesses/",
        {"recording": str(recording.id), "team": group.group_key, "role": MEMBER},
        format="json",
    )
    assert response.status_code == 400


def test_both_user_and_team_is_rejected_with_a_field_error_not_a_500():
    organization, admin = _org_with_admin()
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    other = _member(organization)
    recording = _owned_recording(admin)

    response = _client(admin).post(
        "/api/v1.0/recording-accesses/",
        {
            "recording": str(recording.id),
            "user": str(other.id),
            "team": group.group_key,
            "role": MEMBER,
        },
        format="json",
    )
    assert response.status_code == 400


def test_non_owner_cannot_share_someone_elses_recording():
    organization, _admin = _org_with_admin()
    stranger = _member(organization)
    group = models.UserGroup.objects.create(organization=organization, name="值班组")
    recording = _owned_recording(factories.UserFactory())

    response = _client(stranger).post(
        "/api/v1.0/recording-accesses/",
        {"recording": str(recording.id), "team": group.group_key, "role": MEMBER},
        format="json",
    )
    assert response.status_code in (403, 400)


def test_listing_grants_only_shows_recordings_you_administer():
    organization, admin = _org_with_admin()
    mine = _owned_recording(admin)
    theirs = _owned_recording(factories.UserFactory())

    response = _client(admin).get("/api/v1.0/recording-accesses/")
    assert response.status_code == 200
    recording_ids = {row["recording"] for row in response.data["results"]}
    assert mine.id in recording_ids
    assert theirs.id not in recording_ids


def test_cannot_revoke_the_last_owner():
    _organization, admin = _org_with_admin()
    recording = _owned_recording(admin)
    access = models.RecordingAccess.objects.get(recording=recording, user=admin)

    response = _client(admin).delete(f"/api/v1.0/recording-accesses/{access.id}/")
    assert response.status_code == 400


def test_directory_exposes_groups_to_plain_members_for_share_pickers():
    organization, _admin = _org_with_admin()
    user = _member(organization)
    models.UserGroup.objects.create(organization=organization, name="值班组")

    response = _client(user).get("/api/v1.0/directory/user-groups/")
    assert response.status_code == 200
    assert [g["name"] for g in response.data] == ["值班组"]
    # Who is in it is an admin question — the picker does not need it.
    assert "members" not in response.data[0]
