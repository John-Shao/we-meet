"""Seeding an organization's built-in admin roles (P10 M2).

Sibling of ``org_dictionary.ensure_builtin_dict_items`` and called from the same
place, for the same reason: no signals in this codebase.
"""

from core import models, permissions_registry


def ensure_builtin_roles(organization) -> int:
    """Create this organization's missing built-in roles. Returns how many.

    Idempotent, and called explicitly rather than from a signal — the same
    reasoning as ``ensure_builtin_dict_items``: the two bulk write paths that
    matter (``update()`` on a queryset) do not fire signals, so a signal-based
    seeder is one that silently misses exactly the cases you would rely on it
    for. See D18 in the P10 design doc.
    """
    if organization is None:
        return 0
    existing = set(
        models.AdminRole.objects.filter(organization=organization).values_list(
            "code", flat=True
        )
    )
    to_create = [
        models.AdminRole(
            organization=organization,
            code=code,
            name=str(label),
            permissions=sorted(perms),
            is_builtin=True,
        )
        for code, (label, perms) in permissions_registry.BUILTIN_ROLES.items()
        if code not in existing
    ]
    for role in to_create:
        role.save()
    return len(to_create)
