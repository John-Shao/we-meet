"""Remove the legacy Work seat-grant permissions from every role.

The Work module was deleted in the 2026-10-27 clean-slate reset. Its two
permission codes no longer exist in the registry; strip them from existing
roles so no role claims a dead permission. Reverse is a no-op: re-adding a
removed code would silently grant access nobody asked for.
"""

from django.db import migrations

CODES = frozenset({"org.work_grant.read", "org.work_grant.write"})


def remove_codes(apps, schema_editor):
    AdminRole = apps.get_model("core", "AdminRole")
    for role in AdminRole.objects.iterator():
        permissions = list(role.permissions or [])
        filtered = [code for code in permissions if code not in CODES]
        if filtered != permissions:
            role.permissions = sorted(filtered)
            role.save(update_fields=["permissions"])


class Migration(migrations.Migration):
    dependencies = [("core", "0233_summary_task_link_reverse_name")]

    operations = [migrations.RunPython(remove_codes, migrations.RunPython.noop)]
