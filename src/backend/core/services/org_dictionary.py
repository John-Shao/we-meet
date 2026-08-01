"""Built-in options for an organization's dictionaries (P10 M1).

The canonical list lives here; migration ``0070_seed_employee_types`` carries a
frozen copy for the existing tenants (migrations must not import app code that
keeps changing under them).

Called explicitly at organization creation rather than from a ``post_save``
signal: this codebase has no signals by design, and an implicit write that fires
inside every test factory is exactly the kind of surprise that convention
avoids.
"""

from core import models

# (code, label, sort_order). ``code`` is what application logic branches on and
# must stay stable; ``label`` is customer-visible and may be renamed freely.
BUILTIN_EMPLOYEE_TYPES = [
    ("formal", "正式", 10),
    ("intern", "实习", 20),
    ("outsourced", "外包", 30),
    ("dispatch", "劳务", 40),
    ("consultant", "顾问", 50),
]

# job_level / job_sequence are intentionally NOT seeded — every customer's
# ladder differs (P/T/M sequences vs numbered grades), so anything we pre-fill
# is just something they have to delete first.
BUILTIN_BY_SCOPE = {
    models.DictScopeChoices.EMPLOYEE_TYPE: BUILTIN_EMPLOYEE_TYPES,
}


def ensure_builtin_dict_items(organization) -> int:
    """Create any missing built-in dictionary options. Idempotent.

    Returns the number of rows created. Never touches existing rows, so a
    customer who renamed 实习 keeps their label.
    """
    created = 0
    for scope, entries in BUILTIN_BY_SCOPE.items():
        existing = set(
            models.OrgDictItem.objects.filter(
                organization=organization, scope=scope
            ).values_list("code", flat=True)
        )
        rows = [
            models.OrgDictItem(
                organization=organization,
                scope=scope,
                code=code,
                label=label,
                sort_order=sort_order,
                is_builtin=True,
                is_active=True,
            )
            for code, label, sort_order in entries
            if code not in existing
        ]
        if rows:
            models.OrgDictItem.objects.bulk_create(rows)
            created += len(rows)
    return created
