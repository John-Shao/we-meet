"""The catalogue of org-administration permissions (P10 M2).

One module, one dict. Everything that grants or checks an administrative right
resolves its string from here, so the set is enumerable: the console renders the
role editor from it, ``AdminRole.permissions`` is validated against it, and a
permission that exists in code but not here simply cannot be granted.

Lives in its own file rather than ``core/enums.py`` — that module is already
regex/constant territory, and this one needs to import nothing from ``core`` (the
model layer imports *it*, so the reverse would be a cycle).

**Naming**: ``org.<subject>.<verb>``. ``read`` implies list+retrieve; ``write``
implies create+update+delete unless a narrower verb exists alongside it
(``org.member.write`` does not cover ``org.member.offboard`` — offboarding
touches Keycloak and resource ownership, so it is deliberately separable).
"""

from django.utils.translation import gettext_lazy as _

#: Permissions that must never be handed to a custom role. Granting
#: ``org.role.write`` to a role is a privilege-escalation primitive: whoever
#: holds it can write themselves any other permission. It stays with the
#: organization's own owner/administrator, checked by org_role, not by role
#: assignment.
OWNER_ONLY = frozenset({"org.role.write"})

#: ``{code: (label, group)}``. ``group`` only drives how the console's role
#: editor buckets the checkboxes; it has no semantics.
PERMISSIONS: dict[str, tuple[object, str]] = {
    # --- organization structure ---
    "org.department.read": (_("View departments"), "structure"),
    "org.department.write": (_("Manage departments"), "structure"),
    "org.member.read": (_("View members"), "structure"),
    "org.member.write": (_("Manage members"), "structure"),
    "org.member.offboard": (_("Offboard and rehire members"), "structure"),
    "org.invitation.write": (_("Invite members"), "structure"),
    "org.group.read": (_("View user groups"), "structure"),
    "org.group.write": (_("Manage user groups"), "structure"),
    # --- sensitive personal data (M3; registered now so a role created today
    # cannot silently gain it when the feature lands) ---
    "org.member.field.sensitive.read": (
        _("Reveal sensitive personal fields"),
        "sensitive",
    ),
    "org.field.config.read": (_("View field configuration"), "sensitive"),
    "org.field.config.write": (_("Manage field configuration"), "sensitive"),
    # --- roles ---
    "org.role.read": (_("View roles and permissions"), "governance"),
    "org.role.write": (_("Manage roles and permissions"), "governance"),
    # --- bulk operations ---
    "org.import.write": (_("Import and export members"), "operations"),
    "org.meeting_room.write": (_("Manage meeting rooms"), "operations"),
    # --- observability ---
    "org.audit.read": (_("View the audit log"), "governance"),
    "org.stats.read": (_("View the dashboard"), "governance"),
    "org.ai_quota.read": (_("View AI usage and quota"), "governance"),
    "org.ai_quota.write": (_("Manage AI quota"), "governance"),
}

ALL_PERMISSIONS = frozenset(PERMISSIONS)

#: Roles seeded into every organization. Deliberately three, not飞书's seven:
#: we-meet has no finance or legal surface, so seeding those roles would create
#: admins who can see nothing — which reads as a broken product, not a spare
#: role. Add one when the feature area it governs exists.
BUILTIN_ROLES: dict[str, tuple[object, frozenset[str]]] = {
    "hr": (
        _("People operations"),
        frozenset(
            {
                "org.department.read",
                "org.department.write",
                "org.member.read",
                "org.member.write",
                "org.member.offboard",
                "org.invitation.write",
                "org.import.write",
                "org.group.read",
                "org.stats.read",
            }
        ),
    ),
    "it": (
        _("IT administration"),
        frozenset(
            {
                "org.department.read",
                "org.member.read",
                "org.member.write",
                "org.invitation.write",
                "org.group.read",
                "org.group.write",
                "org.audit.read",
                "org.stats.read",
                "org.ai_quota.read",
            }
        ),
    ),
    "admin_office": (
        _("Workplace administration"),
        frozenset(
            {
                "org.department.read",
                "org.member.read",
                "org.meeting_room.write",
                "org.stats.read",
            }
        ),
    ),
}


def validate_permission_codes(codes) -> list[str]:
    """Normalize a permission list, rejecting anything not in the registry.

    Returns a sorted, de-duplicated list. Raises ``ValueError`` naming the
    offenders — an unknown code is not a harmless no-op: it reads in the console
    as a granted right that silently does nothing.
    """
    cleaned = {str(code).strip() for code in codes or [] if str(code).strip()}
    unknown = sorted(cleaned - ALL_PERMISSIONS)
    if unknown:
        raise ValueError(", ".join(unknown))
    forbidden = sorted(cleaned & OWNER_ONLY)
    if forbidden:
        raise ValueError(", ".join(forbidden))
    return sorted(cleaned)


def permission_catalogue() -> list[dict]:
    """The registry as JSON for the console's role editor."""
    return [
        {
            "code": code,
            "label": str(label),
            "group": group,
            "owner_only": code in OWNER_ONLY,
        }
        for code, (label, group) in PERMISSIONS.items()
    ]
