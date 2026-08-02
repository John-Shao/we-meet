"""Who may administer what, resolved once per request (P10 M2).

Two audiences, one answer:

- ``org_role`` owners/administrators keep every permission, unscoped. That is
  the pre-M2 behaviour and it does not change — ``IsOrgAdmin`` still means what
  it meant, so the six existing admin modules need no edit.
- Everyone else gets exactly the union of their :class:`AdminRole` assignments,
  narrowed to the department subtrees those assignments name.

The resolved answer is a frozen :class:`OrgAdminContext` cached on the request,
because a single admin request asks "may I?" several times (permission class,
queryset filter, per-object write check) and each of those would otherwise be
its own JOIN.
"""

from dataclasses import dataclass, field

from django.db.models import Q

from core import models
from core.permissions_registry import ALL_PERMISSIONS


@dataclass(frozen=True)
class OrgAdminContext:
    """Everything an administrative request needs to know about its caller."""

    organization: object | None
    membership: object | None
    permissions: frozenset = field(default_factory=frozenset)
    scope_type: str = models.AdminScopeChoices.ALL
    #: ``Department.path`` prefixes. Empty tuple with ``scope_type == "all"``
    #: means "no narrowing"; empty tuple with ``"departments"`` means a scoped
    #: assignment that names no department — which reaches nothing, not
    #: everything. ``in_scope`` distinguishes the two.
    scope_paths: tuple = ()
    #: True for the organization's own owner/administrator.
    is_org_admin: bool = False

    def has(self, permission: str) -> bool:
        return permission in self.permissions

    @property
    def is_scoped(self) -> bool:
        return self.scope_type == models.AdminScopeChoices.DEPARTMENTS

    def in_scope(self, department) -> bool:
        """Is this department (or None = org level) inside the caller's scope?

        ``None`` means the org root — a member with no department. A scoped
        administrator does NOT administer them: "you manage Engineering" cannot
        reasonably include people who are in no department at all.
        """
        if not self.is_scoped:
            return True
        if department is None:
            return False
        path = getattr(department, "path", department)
        return any(path.startswith(prefix) for prefix in self.scope_paths)

    def filter_departments(self, queryset):
        """Narrow a Department queryset to the caller's scope."""
        if not self.is_scoped:
            return queryset
        if not self.scope_paths:
            return queryset.none()
        condition = Q()
        for prefix in self.scope_paths:
            condition |= Q(path__startswith=prefix)
        return queryset.filter(condition)

    def filter_memberships(self, queryset):
        """Narrow a Membership queryset to the caller's scope."""
        if not self.is_scoped:
            return queryset
        if not self.scope_paths:
            return queryset.none()
        condition = Q()
        for prefix in self.scope_paths:
            condition |= Q(department__path__startswith=prefix)
        return queryset.filter(condition)


_EMPTY = OrgAdminContext(organization=None, membership=None)


def _resolve(user) -> OrgAdminContext:
    # Circular at import time: directory imports models, models is imported here.
    from core.api.directory import get_caller_membership, is_caller_org_admin

    membership = get_caller_membership(user)
    if membership is None:
        return _EMPTY
    organization = membership.organization

    # Deliberately ``is_caller_org_admin`` and not ``membership.org_role``: the
    # rule is "**any** active membership carries an admin role", because someone
    # whose primary membership is a plain member may still administer via a
    # second one. Reading only the primary here would silently narrow a gate
    # that has always been the broader one — M1 unified the two definitions
    # precisely so they could not drift again.
    if is_caller_org_admin(user):
        # Owners and administrators are not modelled as role holders. Doing so
        # would mean an org could lock itself out by editing a seeded role.
        return OrgAdminContext(
            organization=organization,
            membership=membership,
            permissions=ALL_PERMISSIONS,
            scope_type=models.AdminScopeChoices.ALL,
            is_org_admin=True,
        )

    assignments = (
        models.AdminRoleAssignment.objects.filter(
            membership=membership,
            role__is_active=True,
            role__organization=organization,
        )
        .select_related("role")
        .prefetch_related("scope_departments__department")
    )

    permissions: set[str] = set()
    scope_paths: set[str] = set()
    scope_type = models.AdminScopeChoices.DEPARTMENTS
    for assignment in assignments:
        # Registry-filtered: a code that was valid when granted but has since
        # been retired must stop working, not linger as a mystery grant.
        permissions.update(set(assignment.role.permissions or []) & ALL_PERMISSIONS)
        if assignment.scope_type == models.AdminScopeChoices.ALL:
            scope_type = models.AdminScopeChoices.ALL
        else:
            for row in assignment.scope_departments.all():
                scope_paths.add(row.department.path)

    if not permissions:
        return OrgAdminContext(organization=organization, membership=membership)

    # An unscoped assignment anywhere wins: scopes are additive, and the widest
    # one the person holds is the one they actually have.
    return OrgAdminContext(
        organization=organization,
        membership=membership,
        permissions=frozenset(permissions),
        scope_type=scope_type,
        scope_paths=tuple(sorted(scope_paths)),
    )


def get_admin_context(request) -> OrgAdminContext:
    """Resolve (and cache on the request) the caller's administrative context."""
    cached = getattr(request, "_org_admin_ctx", None)
    if cached is None:
        user = getattr(request, "user", None)
        cached = (
            _resolve(user)
            if user is not None and user.is_authenticated
            else _EMPTY
        )
        request._org_admin_ctx = cached  # noqa: SLF001 — request is ours
    return cached
