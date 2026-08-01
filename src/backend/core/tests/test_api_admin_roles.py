"""Custom admin roles, permission resolution, and department scoping (P10 M2).

The interesting cases are not CRUD. They are:

- an org owner/administrator keeps everything, unscoped — M2 must not narrow
  what already worked;
- a role holder gets exactly their union, and nothing near it;
- ``org.role.write`` cannot be put inside a role, because a role that can edit
  roles can grant itself the rest;
- a department-scoped assignment reaches the *subtree*, and reaches nobody when
  it names no department (rather than reaching everybody).
"""

import pytest
from rest_framework.test import APIClient

from core import factories, models, permissions_registry
from core.services.org_permissions import get_admin_context
from core.services.org_roles import ensure_builtin_roles

pytestmark = pytest.mark.django_db


class _Req:
    """Minimal stand-in for a DRF request — get_admin_context only reads .user."""

    def __init__(self, user):
        self.user = user


def _org():
    return factories.OrganizationFactory()


def _membership(organization, role=models.OrgRoleChoices.MEMBER, department=None):
    user = factories.UserFactory()
    return models.Membership.objects.create(
        organization=organization,
        user=user,
        org_role=role,
        department=department,
        is_primary=True,
    )


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _role(organization, code="hr", permissions=("org.member.read",)):
    return models.AdminRole.objects.create(
        organization=organization,
        code=code,
        name=code.upper(),
        permissions=list(permissions),
    )


# --- the registry ----------------------------------------------------------


def test_builtin_roles_only_reference_registered_permissions():
    """A seeded role granting an unknown code would be a right that does nothing."""
    for code, (_label, perms) in permissions_registry.BUILTIN_ROLES.items():
        unknown = perms - permissions_registry.ALL_PERMISSIONS
        assert not unknown, f"{code} grants unregistered {sorted(unknown)}"


def test_no_builtin_role_can_edit_roles():
    """Otherwise a seeded role is a ready-made escalation path."""
    for code, (_label, perms) in permissions_registry.BUILTIN_ROLES.items():
        assert not (perms & permissions_registry.OWNER_ONLY), code


def test_validate_permission_codes_rejects_unknown_and_owner_only():
    with pytest.raises(ValueError):
        permissions_registry.validate_permission_codes(["org.nope.read"])
    with pytest.raises(ValueError):
        permissions_registry.validate_permission_codes(["org.role.write"])
    assert permissions_registry.validate_permission_codes(
        ["org.member.read", "org.member.read", " org.audit.read "]
    ) == ["org.audit.read", "org.member.read"]


# --- context resolution ----------------------------------------------------


def test_org_admin_keeps_everything_unscoped():
    organization = _org()
    admin = _membership(organization, models.OrgRoleChoices.ADMIN)

    ctx = get_admin_context(_Req(admin.user))
    assert ctx.is_org_admin is True
    assert ctx.permissions == permissions_registry.ALL_PERMISSIONS
    assert ctx.is_scoped is False


def test_plain_member_has_nothing():
    organization = _org()
    member = _membership(organization)

    ctx = get_admin_context(_Req(member.user))
    assert ctx.permissions == frozenset()
    assert ctx.is_org_admin is False


def test_role_holder_gets_exactly_their_union():
    organization = _org()
    holder = _membership(organization)
    models.AdminRoleAssignment.objects.create(
        role=_role(organization, "hr", ["org.member.read", "org.member.write"]),
        membership=holder,
    )
    models.AdminRoleAssignment.objects.create(
        role=_role(organization, "it", ["org.audit.read"]),
        membership=holder,
    )

    ctx = get_admin_context(_Req(holder.user))
    assert ctx.permissions == frozenset(
        {"org.member.read", "org.member.write", "org.audit.read"}
    )
    assert ctx.has("org.role.write") is False


def test_retired_permission_codes_stop_working():
    """A code that left the registry must not linger as a mystery grant."""
    organization = _org()
    holder = _membership(organization)
    role = _role(organization, "legacy", ["org.member.read"])
    # Simulate a code retired after it was granted: bypass validation the way a
    # historical row would have.
    models.AdminRole.objects.filter(pk=role.pk).update(
        permissions=["org.member.read", "org.retired.thing"]
    )
    models.AdminRoleAssignment.objects.create(role=role, membership=holder)

    ctx = get_admin_context(_Req(holder.user))
    assert ctx.permissions == frozenset({"org.member.read"})


def test_inactive_role_grants_nothing():
    organization = _org()
    holder = _membership(organization)
    role = _role(organization, "hr", ["org.member.read"])
    role.is_active = False
    role.save()
    models.AdminRoleAssignment.objects.create(role=role, membership=holder)

    assert get_admin_context(_Req(holder.user)).permissions == frozenset()


# --- department scoping ----------------------------------------------------


def _tree(organization):
    root = models.Department.objects.create(organization=organization, name="Eng")
    child = models.Department.objects.create(
        organization=organization, name="Platform", parent=root
    )
    other = models.Department.objects.create(organization=organization, name="Sales")
    return root, child, other


def test_scope_reaches_the_whole_subtree():
    organization = _org()
    root, child, other = _tree(organization)
    holder = _membership(organization)
    assignment = models.AdminRoleAssignment.objects.create(
        role=_role(organization, "hr", ["org.member.read"]),
        membership=holder,
        scope_type=models.AdminScopeChoices.DEPARTMENTS,
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=assignment, department=root
    )

    ctx = get_admin_context(_Req(holder.user))
    assert ctx.is_scoped is True
    assert ctx.in_scope(root) is True
    # A subtree, not just direct children — "manages Engineering" that stops one
    # level down is useless in any org deeper than two levels.
    assert ctx.in_scope(child) is True
    assert ctx.in_scope(other) is False


def test_scope_excludes_people_with_no_department():
    organization = _org()
    root, _child, _other = _tree(organization)
    holder = _membership(organization)
    assignment = models.AdminRoleAssignment.objects.create(
        role=_role(organization, "hr", ["org.member.read"]),
        membership=holder,
        scope_type=models.AdminScopeChoices.DEPARTMENTS,
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=assignment, department=root
    )

    # org-level members are not "inside Engineering" by any reading.
    assert get_admin_context(_Req(holder.user)).in_scope(None) is False


def test_an_unscoped_assignment_widens_a_scoped_one():
    organization = _org()
    root, _child, other = _tree(organization)
    holder = _membership(organization)
    scoped = models.AdminRoleAssignment.objects.create(
        role=_role(organization, "hr", ["org.member.read"]),
        membership=holder,
        scope_type=models.AdminScopeChoices.DEPARTMENTS,
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=scoped, department=root
    )
    models.AdminRoleAssignment.objects.create(
        role=_role(organization, "it", ["org.audit.read"]),
        membership=holder,
        scope_type=models.AdminScopeChoices.ALL,
    )

    ctx = get_admin_context(_Req(holder.user))
    assert ctx.is_scoped is False
    assert ctx.in_scope(other) is True


def test_filter_memberships_narrows_to_the_subtree():
    organization = _org()
    root, child, other = _tree(organization)
    inside = _membership(organization, department=child)
    outside = _membership(organization, department=other)
    holder = _membership(organization)
    assignment = models.AdminRoleAssignment.objects.create(
        role=_role(organization, "hr", ["org.member.read"]),
        membership=holder,
        scope_type=models.AdminScopeChoices.DEPARTMENTS,
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=assignment, department=root
    )

    ctx = get_admin_context(_Req(holder.user))
    visible = set(
        ctx.filter_memberships(
            models.Membership.objects.filter(organization=organization)
        ).values_list("id", flat=True)
    )
    assert inside.id in visible
    assert outside.id not in visible


# --- the API ---------------------------------------------------------------


def test_owner_can_create_a_role():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)

    response = _client(owner.user).post(
        "/api/v1.0/admin/roles/",
        {"name": "招聘", "code": "recruiting", "permissions": ["org.member.read"]},
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["permissions"] == ["org.member.read"]


def test_a_role_cannot_be_given_the_power_to_edit_roles():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)

    response = _client(owner.user).post(
        "/api/v1.0/admin/roles/",
        {"name": "超级", "code": "super", "permissions": ["org.role.write"]},
        format="json",
    )
    assert response.status_code == 400
    assert "permissions" in response.data


def test_unknown_permission_is_rejected_not_stored():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)

    response = _client(owner.user).post(
        "/api/v1.0/admin/roles/",
        {"name": "x", "code": "x", "permissions": ["org.made.up"]},
        format="json",
    )
    assert response.status_code == 400


def test_role_holder_without_role_write_cannot_manage_roles():
    """The escalation guard, end to end."""
    organization = _org()
    holder = _membership(organization)
    models.AdminRoleAssignment.objects.create(
        role=_role(organization, "hr", ["org.member.read", "org.role.read"]),
        membership=holder,
    )

    client = _client(holder.user)
    assert client.get("/api/v1.0/admin/roles/").status_code == 200
    assert (
        client.post(
            "/api/v1.0/admin/roles/",
            {"name": "x", "code": "x", "permissions": []},
            format="json",
        ).status_code
        == 403
    )


def test_plain_member_cannot_even_read_roles():
    organization = _org()
    member = _membership(organization)
    assert _client(member.user).get("/api/v1.0/admin/roles/").status_code == 403


def test_builtin_roles_cannot_be_deleted():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)
    ensure_builtin_roles(organization)
    role = models.AdminRole.objects.get(organization=organization, code="hr")

    response = _client(owner.user).delete(f"/api/v1.0/admin/roles/{role.id}/")
    assert response.status_code == 400


def test_role_update_audits_the_diff_not_the_whole_set():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)
    role = _role(organization, "hr", ["org.member.read", "org.audit.read"])

    response = _client(owner.user).patch(
        f"/api/v1.0/admin/roles/{role.id}/",
        {"permissions": ["org.member.read", "org.member.write"]},
        format="json",
    )
    assert response.status_code == 200, response.data

    audit = models.AuditLog.objects.get(action=models.AuditActionChoices.ROLE_UPDATE)
    assert audit.metadata["granted"] == ["org.member.write"]
    assert audit.metadata["revoked"] == ["org.audit.read"]


def test_assigning_a_scoped_role_requires_departments():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)
    target = _membership(organization)
    role = _role(organization)

    response = _client(owner.user).post(
        "/api/v1.0/admin/role-assignments/",
        {
            "role": str(role.id),
            "membership": str(target.id),
            "scope_type": "departments",
            "department_ids": [],
        },
        format="json",
    )
    assert response.status_code == 400
    assert "department_ids" in response.data


def test_assignment_creates_scope_rows():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)
    target = _membership(organization)
    role = _role(organization)
    root, _child, _other = _tree(organization)

    response = _client(owner.user).post(
        "/api/v1.0/admin/role-assignments/",
        {
            "role": str(role.id),
            "membership": str(target.id),
            "scope_type": "departments",
            "department_ids": [str(root.id)],
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert [d["name"] for d in response.data["departments"]] == ["Eng"]


def test_cannot_assign_a_role_to_another_organizations_member():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)
    outsider = _membership(_org())
    role = _role(organization)

    response = _client(owner.user).post(
        "/api/v1.0/admin/role-assignments/",
        {"role": str(role.id), "membership": str(outsider.id)},
        format="json",
    )
    assert response.status_code == 400


def test_directory_me_reports_permissions_and_scope():
    organization = _org()
    root, _child, _other = _tree(organization)
    holder = _membership(organization)
    assignment = models.AdminRoleAssignment.objects.create(
        role=_role(organization, "hr", ["org.member.read"]),
        membership=holder,
        scope_type=models.AdminScopeChoices.DEPARTMENTS,
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=assignment, department=root
    )

    response = _client(holder.user).get("/api/v1.0/directory/me/")
    assert response.status_code == 200
    assert response.data["permissions"] == ["org.member.read"]
    assert response.data["admin_scope"]["type"] == "departments"
    assert response.data["admin_scope"]["department_ids"] == [str(root.id)]
    # The pre-M2 field keeps its meaning for clients that only know it.
    assert response.data["is_org_admin"] is False


def test_directory_me_for_owner_lists_everything():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)

    response = _client(owner.user).get("/api/v1.0/directory/me/")
    assert set(response.data["permissions"]) == permissions_registry.ALL_PERMISSIONS
    assert response.data["admin_scope"]["type"] == "all"


def test_permission_catalogue_is_gated_on_role_read():
    organization = _org()
    owner = _membership(organization, models.OrgRoleChoices.OWNER)
    member = _membership(organization)

    ok = _client(owner.user).get("/api/v1.0/admin/permissions/")
    assert ok.status_code == 200
    assert {p["code"] for p in ok.data["permissions"]} == (
        permissions_registry.ALL_PERMISSIONS
    )

    assert _client(member.user).get("/api/v1.0/admin/permissions/").status_code == 403


def test_ensure_builtin_roles_is_idempotent():
    organization = _org()
    assert ensure_builtin_roles(organization) == len(
        permissions_registry.BUILTIN_ROLES
    )
    assert ensure_builtin_roles(organization) == 0
