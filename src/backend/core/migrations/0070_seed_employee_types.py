# Data migration — P10 M1: seed the built-in 人员类型 (employee type) options for
# every organization.
#
# Only ``employee_type`` is seeded. ``job_level`` / ``job_sequence`` are left
# empty on purpose: every customer's ladder differs (P/T/M sequences vs numbered
# grades), so pre-filling them would only be something to delete first.
#
# Built-in rows may be renamed by the customer but not deleted, so the reverse
# only removes rows still carrying their seeded label — a renamed option is the
# customer's data, not ours to drop.

from django.db import migrations

SCOPE = "employee_type"

# (code, label, sort_order) — codes are what application logic branches on and
# must stay stable; labels are the customer-visible text and may be renamed.
BUILTIN_EMPLOYEE_TYPES = [
    ("formal", "正式", 10),
    ("intern", "实习", 20),
    ("outsourced", "外包", 30),
    ("dispatch", "劳务", 40),
    ("consultant", "顾问", 50),
]


def seed_employee_types(apps, schema_editor):
    """Give every organization the five built-in employee types. Idempotent."""
    Organization = apps.get_model("core", "Organization")
    OrgDictItem = apps.get_model("core", "OrgDictItem")

    for organization in Organization.objects.all().iterator():
        existing = set(
            OrgDictItem.objects.filter(
                organization=organization, scope=SCOPE
            ).values_list("code", flat=True)
        )
        OrgDictItem.objects.bulk_create(
            [
                OrgDictItem(
                    organization=organization,
                    scope=SCOPE,
                    code=code,
                    label=label,
                    sort_order=sort_order,
                    is_builtin=True,
                    is_active=True,
                )
                for code, label, sort_order in BUILTIN_EMPLOYEE_TYPES
                if code not in existing
            ]
        )


def unseed_employee_types(apps, schema_editor):
    """Reverse: drop only the untouched seeds (a renamed option is customer data)."""
    OrgDictItem = apps.get_model("core", "OrgDictItem")
    for code, label, _sort_order in BUILTIN_EMPLOYEE_TYPES:
        OrgDictItem.objects.filter(
            scope=SCOPE, code=code, label=label, is_builtin=True
        ).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0069_org_dictionary_and_work_fields"),
    ]

    operations = [
        migrations.RunPython(seed_employee_types, reverse_code=unseed_employee_types),
    ]
