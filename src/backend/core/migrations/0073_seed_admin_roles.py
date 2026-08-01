# Data migration — P10 M2: seed the built-in admin roles for every organization.
#
# Three roles, not飞书's seven. we-meet has no finance or legal surface, so
# seeding those would create administrators who open the console and see nothing
# — which reads as a broken product, not as a spare role waiting for a feature.
#
# ⚠️ ``OrgRoleChoices.DEPT_ADMIN`` rows are deliberately NOT converted into role
# assignments. That enum value has never been read by any permission check in
# this codebase (see the P10 design doc, F-table): a member carrying it has
# exactly the powers of a plain member today. Turning those rows into real
# assignments would therefore *grant* administrative access to people who never
# had it — a silent privilege escalation performed by a migration. They stay as
# they are; an admin who wants those people to administer something assigns them
# a role explicitly, and that action lands in the audit log where it belongs.

from django.db import migrations

# Kept as a literal rather than imported from core.permissions_registry: a data
# migration must describe the world at the time it ran, and the registry will
# keep changing. Later edits to the registry do not retroactively rewrite roles
# an organization has already customized.
BUILTIN_ROLES = [
    (
        "hr",
        "People operations",
        [
            "org.department.read",
            "org.department.write",
            "org.group.read",
            "org.import.write",
            "org.invitation.write",
            "org.member.offboard",
            "org.member.read",
            "org.member.write",
            "org.stats.read",
        ],
    ),
    (
        "it",
        "IT administration",
        [
            "org.ai_quota.read",
            "org.audit.read",
            "org.department.read",
            "org.group.read",
            "org.group.write",
            "org.invitation.write",
            "org.member.read",
            "org.member.write",
            "org.stats.read",
        ],
    ),
    (
        "admin_office",
        "Workplace administration",
        [
            "org.department.read",
            "org.meeting_room.write",
            "org.member.read",
            "org.stats.read",
        ],
    ),
]


def seed_admin_roles(apps, schema_editor):
    """Give every organization the three built-in roles. Idempotent."""
    Organization = apps.get_model("core", "Organization")
    AdminRole = apps.get_model("core", "AdminRole")

    for organization in Organization.objects.all().iterator():
        existing = set(
            AdminRole.objects.filter(organization=organization).values_list(
                "code", flat=True
            )
        )
        AdminRole.objects.bulk_create(
            [
                AdminRole(
                    organization=organization,
                    code=code,
                    name=name,
                    permissions=permissions,
                    is_builtin=True,
                    is_active=True,
                )
                for code, name, permissions in BUILTIN_ROLES
                if code not in existing
            ]
        )


def unseed_admin_roles(apps, schema_editor):
    """Reverse: drop only roles nobody holds and nobody has edited.

    A role that has been assigned or had its permission set customized is the
    customer's configuration, not ours to delete on a rollback.
    """
    AdminRole = apps.get_model("core", "AdminRole")
    for code, name, permissions in BUILTIN_ROLES:
        AdminRole.objects.filter(
            code=code, name=name, permissions=permissions, is_builtin=True
        ).exclude(assignments__isnull=False).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0072_admin_roles"),
    ]

    operations = [
        migrations.RunPython(seed_admin_roles, reverse_code=unseed_admin_roles),
    ]
