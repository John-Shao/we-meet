"""Give existing built-in roles the Work grant read permission.

New organizations are seeded from ``permissions_registry.BUILTIN_ROLES``, so the
registry and this migration must agree. Only ``is_builtin`` rows are touched and
only by union: an administrator's customised permission set keeps every entry it
had. ``write`` is deliberately absent — granting a Work seat spends the tenant's
money, so it stays an explicit owner decision.
"""

from django.db import migrations

READ_PERMISSION = "org.work_grant.read"
BUILTIN_CODES = ("hr", "it", "admin_office")


def add_read_permission(apps, schema_editor):
    AdminRole = apps.get_model("core", "AdminRole")
    roles = AdminRole.objects.filter(is_builtin=True, code__in=BUILTIN_CODES)
    for role in roles.iterator():
        permissions = list(role.permissions or [])
        if READ_PERMISSION in permissions:
            continue
        role.permissions = sorted({*permissions, READ_PERMISSION})
        role.save(update_fields=["permissions"])


class Migration(migrations.Migration):
    dependencies = [("core", "0231_organization_lifecycle")]

    operations = [
        # Reverse is a no-op: a code that is no longer in the registry is
        # filtered out by ``_resolve`` anyway, and stripping it on rollback
        # could erase a permission an administrator granted deliberately.
        migrations.RunPython(add_read_permission, migrations.RunPython.noop),
    ]
