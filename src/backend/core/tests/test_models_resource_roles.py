"""``get_resource_roles`` across both access-control shapes.

The codebase has two of them and they are not one system:

- ``RecordingAccess`` inherits ``BaseAccess`` — has a ``team`` column, nullable
  ``user``, and a ``BaseAccessManager`` with ``filter_user``.
- ``ResourceAccess`` (rooms) is a plain ``BaseModel`` — no ``team``, non-null
  ``user``, default manager.

``get_resource_roles`` is reachable from both and used to assume the first,
raising ``AttributeError`` on the second. These tests pin the behaviour for
each so the next person to widen team access doesn't quietly break one half.
"""

import pytest

from core import factories, models

pytestmark = pytest.mark.django_db

OWNER = models.RoleChoices.OWNER
ADMIN = models.RoleChoices.ADMIN
MEMBER = models.RoleChoices.MEMBER


def _membership(org, user, department=None):
    return models.Membership.objects.create(
        organization=org, user=user, department=department, is_primary=True
    )


# --- rooms (plain ResourceAccess) --------------------------------------------


def test_room_roles_resolve_without_a_team_aware_manager():
    """The exact call that used to raise AttributeError."""
    user = factories.UserFactory()
    room = factories.RoomFactory()
    models.ResourceAccess.objects.create(resource=room, user=user, role=OWNER)

    fresh = models.Room.objects.get(pk=room.pk)
    assert models.get_resource_roles(fresh, user) == [OWNER]


def test_room_roles_are_empty_for_a_stranger():
    room = factories.RoomFactory()
    models.ResourceAccess.objects.create(
        resource=room, user=factories.UserFactory(), role=OWNER
    )

    assert models.get_resource_roles(room, factories.UserFactory()) == []


def test_room_roles_ignore_department_membership():
    """Rooms have no team grants — a department key must not leak a role in."""
    org = factories.OrganizationFactory()
    department = models.Department.objects.create(organization=org, name="Eng")
    user = factories.UserFactory()
    _membership(org, user, department=department)

    room = factories.RoomFactory()
    # There is no way to even express this on ResourceAccess (no team column),
    # so the assertion is that being in the department grants nothing.
    assert department.team_key in user.get_teams()
    assert models.get_resource_roles(room, user) == []


def test_room_abilities_path_still_works():
    """`Resource.get_role` is the room ACL entry point and stays user-only."""
    user = factories.UserFactory()
    room = factories.RoomFactory()
    models.ResourceAccess.objects.create(resource=room, user=user, role=ADMIN)

    assert room.get_role(user) == ADMIN
    assert room.is_administrator_or_owner(user) is True
    assert room.is_owner(user) is False


# --- recordings (team-aware RecordingAccess) ---------------------------------


def test_recording_roles_include_direct_user_grants():
    user = factories.UserFactory()
    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, user=user, role=OWNER
    )

    assert models.get_resource_roles(recording, user) == [OWNER]


def test_recording_roles_include_department_team_grants():
    """The P1 promise: share with a department, members get it with no viewset change."""
    org = factories.OrganizationFactory()
    department = models.Department.objects.create(organization=org, name="Eng")
    user = factories.UserFactory()
    _membership(org, user, department=department)

    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, team=department.team_key, role=MEMBER
    )

    assert models.get_resource_roles(recording, user) == [MEMBER]


def test_recording_team_grant_does_not_reach_outsiders():
    org = factories.OrganizationFactory()
    department = models.Department.objects.create(organization=org, name="Eng")
    outsider = factories.UserFactory()

    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, team=department.team_key, role=MEMBER
    )

    assert models.get_resource_roles(recording, outsider) == []


# --- shared contract ---------------------------------------------------------


def test_anonymous_gets_nothing_from_either_shape():
    from django.contrib.auth.models import AnonymousUser

    anon = AnonymousUser()
    assert models.get_resource_roles(factories.RoomFactory(), anon) == []
    assert models.get_resource_roles(factories.RecordingFactory(), anon) == []


def test_roles_are_deduplicated():
    """Two grants of the same role must not report it twice."""
    org = factories.OrganizationFactory()
    department = models.Department.objects.create(organization=org, name="Eng")
    user = factories.UserFactory()
    _membership(org, user, department=department)

    recording = factories.RecordingFactory()
    models.RecordingAccess.objects.create(
        recording=recording, user=user, role=MEMBER
    )
    models.RecordingAccess.objects.create(
        recording=recording, team=department.team_key, role=MEMBER
    )

    assert models.get_resource_roles(recording, user) == [MEMBER]
