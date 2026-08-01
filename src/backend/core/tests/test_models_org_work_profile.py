"""Model tests for the P10 M1 org work-profile additions.

Covers the dictionary table, the new Membership work fields and their
constraints, reporting-line validation, and the offboarding snapshot.
"""

import pytest
from django.core.exceptions import ValidationError
from django.utils import timezone

from core import factories, models
from core.services.org_dictionary import (
    BUILTIN_EMPLOYEE_TYPES,
    ensure_builtin_dict_items,
)

pytestmark = pytest.mark.django_db

EMPLOYEE_TYPE = models.DictScopeChoices.EMPLOYEE_TYPE


def _membership(org, user=None, **kwargs):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        is_primary=kwargs.pop("is_primary", False),
        **kwargs,
    )


# --- dictionary --------------------------------------------------------------


def test_ensure_builtin_dict_items_seeds_and_is_idempotent():
    org = factories.OrganizationFactory()

    created = ensure_builtin_dict_items(org)
    assert created == len(BUILTIN_EMPLOYEE_TYPES)

    codes = set(
        models.OrgDictItem.objects.filter(
            organization=org, scope=EMPLOYEE_TYPE
        ).values_list("code", flat=True)
    )
    assert codes == {code for code, _label, _order in BUILTIN_EMPLOYEE_TYPES}

    # Second call creates nothing.
    assert ensure_builtin_dict_items(org) == 0
    assert models.OrgDictItem.objects.filter(organization=org).count() == len(
        BUILTIN_EMPLOYEE_TYPES
    )


def test_ensure_builtin_dict_items_keeps_customer_renames():
    org = factories.OrganizationFactory()
    ensure_builtin_dict_items(org)

    item = models.OrgDictItem.objects.get(organization=org, code="intern")
    item.label = "实习生（renamed）"
    item.save()

    ensure_builtin_dict_items(org)
    item.refresh_from_db()
    assert item.label == "实习生（renamed）"


def test_dict_item_code_unique_per_org_and_scope():
    org = factories.OrganizationFactory()
    models.OrgDictItem.objects.create(
        organization=org, scope=EMPLOYEE_TYPE, code="formal", label="正式"
    )
    # BaseModel.save() runs full_clean(), so constraint violations surface as
    # ValidationError with the readable message rather than a raw IntegrityError.
    with pytest.raises(ValidationError) as exc:
        models.OrgDictItem.objects.create(
            organization=org, scope=EMPLOYEE_TYPE, code="formal", label="Duplicate"
        )
    assert "already has an option with this code" in str(exc.value)


def test_dict_item_same_code_allowed_in_another_scope():
    org = factories.OrganizationFactory()
    models.OrgDictItem.objects.create(
        organization=org, scope=EMPLOYEE_TYPE, code="p5", label="正式"
    )
    # Same code under a different dictionary is a different option entirely.
    models.OrgDictItem.objects.create(
        organization=org,
        scope=models.DictScopeChoices.JOB_LEVEL,
        code="p5",
        label="P5",
    )


# --- employee_no / department code uniqueness -------------------------------


def test_employee_no_unique_per_org_but_blank_is_free():
    org = factories.OrganizationFactory()
    _membership(org, employee_no="E1001")

    with pytest.raises(ValidationError) as exc:
        _membership(org, employee_no="E1001")
    assert "employee number is already used" in str(exc.value)


def test_blank_employee_no_does_not_collide():
    org = factories.OrganizationFactory()
    # Several members without an employee number must coexist — the constraint
    # is partial precisely so the common case stays unconstrained.
    _membership(org, employee_no="")
    _membership(org, employee_no="")
    assert models.Membership.objects.filter(organization=org, employee_no="").count() == 2


def test_department_code_unique_among_live_rows_only():
    org = factories.OrganizationFactory()
    first = models.Department.objects.create(organization=org, name="Eng", code="D001")

    with pytest.raises(ValidationError) as exc:
        models.Department.objects.create(organization=org, name="Other", code="D001")
    assert "already has a department with this code" in str(exc.value)

    # Soft-deleting frees the code again — otherwise a deleted department would
    # squat on its external identifier forever and block re-import.
    models.Department.objects.filter(pk=first.pk).update(
        deleted_at=timezone.now(), is_active=False
    )
    models.Department.objects.create(organization=org, name="Eng v2", code="D001")


def test_blank_department_code_does_not_collide():
    org = factories.OrganizationFactory()
    models.Department.objects.create(organization=org, name="A")
    models.Department.objects.create(organization=org, name="B")


# --- reporting lines ---------------------------------------------------------


def test_manager_must_be_in_same_organization():
    org, other = factories.OrganizationFactory(), factories.OrganizationFactory()
    boss = _membership(other)
    report = _membership(org)
    report.manager = boss

    with pytest.raises(ValidationError) as exc:
        report.full_clean()
    assert "manager" in exc.value.message_dict


def test_manager_cannot_be_self():
    org = factories.OrganizationFactory()
    member = _membership(org)
    member.manager = member

    with pytest.raises(ValidationError) as exc:
        member.full_clean()
    assert "manager" in exc.value.message_dict


def test_manager_cycle_is_rejected():
    """A→B→A must not be creatable: it would spin _direct_manager forever."""
    org = factories.OrganizationFactory()
    alice = _membership(org)
    bob = _membership(org)

    bob.manager = alice
    bob.full_clean()
    bob.save()

    # Now try to close the loop.
    alice.manager = bob
    with pytest.raises(ValidationError) as exc:
        alice.full_clean()
    assert "cycle" in str(exc.value).lower()


def test_valid_reporting_chain_passes():
    org = factories.OrganizationFactory()
    top = _membership(org)
    mid = _membership(org, manager=top)
    bottom = _membership(org)
    bottom.manager = mid
    bottom.full_clean()  # three levels, no cycle


def test_dotted_manager_may_cross_the_solid_line():
    """Dotted lines are allowed to form shapes the solid line forbids."""
    org = factories.OrganizationFactory()
    alice = _membership(org)
    bob = _membership(org, manager=alice)

    alice.dotted_manager = bob  # would be a cycle on the solid line
    alice.full_clean()


# --- offboarding snapshot ----------------------------------------------------


def test_build_left_snapshot_freezes_department_facts():
    org = factories.OrganizationFactory()
    department = models.Department.objects.create(organization=org, name="研发部")
    boss_user = factories.UserFactory(full_name="Boss Person")
    boss = _membership(org, user=boss_user, department=department)
    ensure_builtin_dict_items(org)
    formal = models.OrgDictItem.objects.get(organization=org, code="formal")

    member = _membership(
        org,
        department=department,
        title="Engineer",
        employee_no="E42",
        employee_type=formal,
        manager=boss,
    )

    snapshot = member.build_left_snapshot()
    assert snapshot["department_name"] == "研发部"
    assert snapshot["department_path"] == department.path
    assert snapshot["title"] == "Engineer"
    assert snapshot["employee_no"] == "E42"
    assert snapshot["employee_type_label"] == "正式"
    assert snapshot["manager_name"] == "Boss Person"

    # The snapshot must survive the department being renamed and soft-deleted —
    # that is the whole reason it is frozen rather than joined.
    department.name = "研发中心"
    department.save()
    assert snapshot["department_name"] == "研发部"


def test_build_left_snapshot_handles_org_level_member():
    org = factories.OrganizationFactory()
    member = _membership(org)
    snapshot = member.build_left_snapshot()
    assert snapshot["department_id"] is None
    assert snapshot["department_name"] == ""
    assert snapshot["manager_id"] is None
