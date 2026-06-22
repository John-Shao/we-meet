"""
Unit tests for the Organization / Department / Membership org-structure models.
"""

from django.core.exceptions import ValidationError
from django.db.utils import IntegrityError

import pytest

from core import factories, models

pytestmark = pytest.mark.django_db


def test_models_organization_str():
    """An organization's string representation is its name."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    assert str(org) == "Acme"


def test_models_department_save_derives_team_key_path_depth():
    """save() derives team_key, materialized path and depth from id + parent."""
    org = models.Organization.objects.create(name="Acme", slug="acme")

    root = models.Department.objects.create(organization=org, name="Root")
    assert root.team_key == f"dept:{root.id.hex}"
    assert root.path == f"{root.id.hex}/"
    assert root.depth == 0

    child = models.Department.objects.create(
        organization=org, name="Engineering", parent=root
    )
    assert child.depth == 1
    assert child.path == f"{root.id.hex}/{child.id.hex}/"
    assert child.path.startswith(root.path)  # subtree-query invariant

    grandchild = models.Department.objects.create(
        organization=org, name="Backend", parent=child
    )
    assert grandchild.depth == 2
    assert grandchild.path.startswith(root.path)
    assert grandchild.path.startswith(child.path)


def test_models_department_subtree_query_by_path():
    """A node's whole subtree (self included) is path__startswith=node.path."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    root = models.Department.objects.create(organization=org, name="Root")
    child = models.Department.objects.create(
        organization=org, name="Engineering", parent=root
    )
    other_root = models.Department.objects.create(organization=org, name="Sales")

    subtree = set(models.Department.objects.filter(path__startswith=root.path))
    assert subtree == {root, child}
    assert other_root not in subtree


def test_models_department_team_key_immutable_across_rename():
    """Renaming a department must not change its access key."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    dept = models.Department.objects.create(organization=org, name="Engineering")
    original_key = dept.team_key

    dept.name = "Engineering & Platform"
    dept.save()
    dept.refresh_from_db()

    assert dept.team_key == original_key


def test_models_department_team_key_fits_base_access_team_column():
    """team_key must fit BaseAccess.team (max_length=100)."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    dept = models.Department.objects.create(organization=org, name="Engineering")
    team_field = models.BaseAccess._meta.get_field("team")
    assert len(dept.team_key) <= team_field.max_length


def test_models_membership_unique_user_department():
    """A user can belong to a given department only once."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    dept = models.Department.objects.create(organization=org, name="Engineering")
    user = factories.UserFactory()

    models.Membership.objects.create(organization=org, user=user, department=dept)
    with pytest.raises((ValidationError, IntegrityError)):
        models.Membership.objects.create(organization=org, user=user, department=dept)


def test_models_membership_one_primary_per_user_org():
    """A user can have only one primary department per organization."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    d1 = models.Department.objects.create(organization=org, name="Engineering")
    d2 = models.Department.objects.create(organization=org, name="Sales")
    user = factories.UserFactory()

    models.Membership.objects.create(
        organization=org, user=user, department=d1, is_primary=True
    )
    with pytest.raises((ValidationError, IntegrityError)):
        models.Membership.objects.create(
            organization=org, user=user, department=d2, is_primary=True
        )


def test_models_membership_non_primary_in_multiple_departments_allowed():
    """The primary constraint must not block non-primary multi-department membership."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    d1 = models.Department.objects.create(organization=org, name="Engineering")
    d2 = models.Department.objects.create(organization=org, name="Sales")
    user = factories.UserFactory()

    models.Membership.objects.create(
        organization=org, user=user, department=d1, is_primary=True
    )
    # Second, non-primary membership in another department is fine.
    second = models.Membership.objects.create(
        organization=org, user=user, department=d2, is_primary=False
    )
    assert second.pk is not None


# ---- User.get_teams() (wired to memberships in P1-c) ----


def test_models_user_get_teams_empty_for_org_level_membership():
    """An organization-level membership (no department) grants no team keys."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=org, user=user, department=None, is_primary=True
    )
    assert user.get_teams() == []


def test_models_user_get_teams_returns_direct_department_keys():
    """get_teams returns the team_key of the user's direct department membership."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    eng = models.Department.objects.create(organization=org, name="Engineering")
    user = factories.UserFactory()
    models.Membership.objects.create(organization=org, user=user, department=eng)

    user = models.User.objects.get(pk=user.pk)  # fresh — avoid stale memoization
    assert user.get_teams() == [eng.team_key]


def test_models_user_get_teams_excludes_inactive_membership_and_department():
    """Suspended memberships and inactive/deleted departments contribute no keys."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    active = models.Department.objects.create(organization=org, name="Engineering")
    inactive = models.Department.objects.create(
        organization=org, name="Legacy", is_active=False
    )
    suspended = models.Department.objects.create(organization=org, name="Sales")
    user = factories.UserFactory()
    models.Membership.objects.create(organization=org, user=user, department=active)
    models.Membership.objects.create(organization=org, user=user, department=inactive)
    models.Membership.objects.create(
        organization=org,
        user=user,
        department=suspended,
        status=models.MembershipStatusChoices.SUSPENDED,
    )

    user = models.User.objects.get(pk=user.pk)
    assert user.get_teams() == [active.team_key]


def test_models_user_get_teams_memoized(django_assert_num_queries):
    """get_teams hits the DB once per instance, then serves from the cache."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    dept = models.Department.objects.create(organization=org, name="Engineering")
    user = factories.UserFactory()
    models.Membership.objects.create(organization=org, user=user, department=dept)

    user = models.User.objects.get(pk=user.pk)
    with django_assert_num_queries(1):
        assert user.get_teams() == [dept.team_key]
        assert user.get_teams() == [dept.team_key]


def test_models_department_team_access_makes_recording_visible():
    """The payoff: a recording shared with a department's team_key is visible to
    its members via BaseAccessManager.filter_user — with zero viewset changes."""
    org = models.Organization.objects.create(name="Acme", slug="acme")
    eng = models.Department.objects.create(organization=org, name="Engineering")
    member = factories.UserFactory()
    outsider = factories.UserFactory()
    models.Membership.objects.create(organization=org, user=member, department=eng)
    models.Membership.objects.create(organization=org, user=outsider, department=None)

    recording = factories.RecordingFactory()
    factories.TeamRecordingAccessFactory(
        recording=recording, team=eng.team_key, role=models.RoleChoices.MEMBER
    )

    member = models.User.objects.get(pk=member.pk)
    outsider = models.User.objects.get(pk=outsider.pk)
    visible_to_member = {
        a.recording_id for a in models.RecordingAccess.objects.filter_user(member)
    }
    visible_to_outsider = {
        a.recording_id for a in models.RecordingAccess.objects.filter_user(outsider)
    }
    assert recording.id in visible_to_member
    assert recording.id not in visible_to_outsider
