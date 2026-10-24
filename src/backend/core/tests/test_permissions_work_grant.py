"""The Work seat permission codes and their built-in role seeding (P1-A).

``org.work_grant.read`` / ``write`` are ordinary org-admin codes: they live in
the registry so the console can render and validate them, they are scopable
(seats belong to natural persons, and people belong to departments), and
``write`` is seeded into no built-in role because a seat is a purchase.
"""

from importlib import import_module

from django.apps import apps as django_apps

import pytest
from rest_framework.test import APIClient

from core import factories, models, permissions_registry

pytestmark = pytest.mark.django_db

# pylint: disable=missing-function-docstring

READ = "org.work_grant.read"
WRITE = "org.work_grant.write"
BUILTIN = ("hr", "it", "admin_office")


def _migration():
    return import_module("core.migrations.0232_builtin_work_grant_permissions")


def test_both_codes_are_registered_under_operations():
    for code in (READ, WRITE):
        assert code in permissions_registry.ALL_PERMISSIONS
        _label, group = permissions_registry.PERMISSIONS[code]
        assert group == "operations"


def test_seat_codes_are_scopable_and_not_owner_only():
    """A seat is held by a person, and a person belongs to departments.

    Locking this down matters: copying ``org.audit.read`` into ``UNSCOPABLE``
    would silently make every department-scoped Work administrator impossible
    to configure.
    """
    assert not ({READ, WRITE} & permissions_registry.UNSCOPABLE)
    assert not ({READ, WRITE} & permissions_registry.OWNER_ONLY)


def test_builtin_roles_read_but_never_write():
    for code in BUILTIN:
        _label, granted = permissions_registry.BUILTIN_ROLES[code]
        assert READ in granted, code
    assert not any(
        WRITE in granted
        for _label, granted in permissions_registry.BUILTIN_ROLES.values()
    )


def test_a_scoped_role_can_hold_both_codes():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=owner,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    department = models.Department.objects.create(organization=organization, name="Eng")
    holder = factories.UserFactory()
    membership = models.Membership.objects.create(
        organization=organization,
        user=holder,
        department=department,
        is_primary=True,
    )
    role = models.AdminRole.objects.create(
        organization=organization,
        code="seat-admin",
        name="Seat admin",
        permissions=[READ, WRITE],
    )

    client = APIClient()
    client.force_login(owner)
    response = client.post(
        "/api/v1.0/admin/role-assignments/",
        {
            "role": str(role.pk),
            "membership": str(membership.pk),
            "scope_type": models.AdminScopeChoices.DEPARTMENTS,
            "department_ids": [str(department.pk)],
        },
        format="json",
    )

    assert response.status_code == 201, response.data


def _role(organization, code, permissions, *, builtin):
    return models.AdminRole.objects.create(
        organization=organization,
        code=code,
        name=code,
        permissions=list(permissions),
        is_builtin=builtin,
    )


def test_migration_unions_read_into_builtin_roles_only():
    organization = factories.OrganizationFactory()
    hr = _role(organization, "hr", ["org.member.read"], builtin=True)
    it = _role(organization, "it", [READ, "org.member.write"], builtin=True)
    custom = _role(organization, "hr-custom", ["org.member.read"], builtin=False)

    _migration().add_read_permission(django_apps, None)

    hr.refresh_from_db()
    it.refresh_from_db()
    custom.refresh_from_db()
    assert hr.permissions == sorted(["org.member.read", READ])
    # Already present: the migration leaves the row alone rather than rewriting
    # it, so only set membership is guaranteed.
    assert set(it.permissions) == {READ, "org.member.write"}
    assert custom.permissions == ["org.member.read"]


def test_migration_keeps_permissions_an_administrator_added():
    """Union, never overwrite: a customized built-in role loses nothing."""
    organization = factories.OrganizationFactory()
    role = _role(
        organization,
        "admin_office",
        ["org.member.read", "org.stats.read", "org.bot.read"],
        builtin=True,
    )

    _migration().add_read_permission(django_apps, None)
    _migration().add_read_permission(django_apps, None)

    role.refresh_from_db()
    assert role.permissions == sorted(
        ["org.member.read", "org.stats.read", "org.bot.read", READ]
    )
