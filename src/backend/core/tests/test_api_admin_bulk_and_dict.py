"""Bulk member operations + organization dictionaries (P10 M1-d)."""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services.org_dictionary import ensure_builtin_dict_items

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
LEFT = models.MembershipStatusChoices.LEFT
MEMBER = models.OrgRoleChoices.MEMBER
ADMIN = models.OrgRoleChoices.ADMIN
OWNER = models.OrgRoleChoices.OWNER
EMPLOYEE_TYPE = models.DictScopeChoices.EMPLOYEE_TYPE
PATCH_DISABLE = "core.tasks.offboarding.disable_keycloak_login"


def _member(org, user=None, **kw):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        is_primary=kw.pop("is_primary", True),
        **kw,
    )


def _admin_client(org, org_role=ADMIN):
    admin = factories.UserFactory()
    _member(org, admin, org_role=org_role)
    client = APIClient()
    client.force_login(admin)
    return client, admin


# --- bulk department change --------------------------------------------------


def test_bulk_department_moves_everyone():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    target_dept = models.Department.objects.create(organization=org, name="Eng")
    people = [_member(org) for _ in range(3)]

    response = client.post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {"ids": [str(m.id) for m in people], "department": str(target_dept.id)},
        format="json",
    )
    assert response.status_code == 200, response.content
    assert response.json()["moved"] == 3
    for m in people:
        m.refresh_from_db()
        assert m.department_id == target_dept.id


def test_bulk_department_to_org_level():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    dept = models.Department.objects.create(organization=org, name="Eng")
    person = _member(org, department=dept)

    response = client.post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {"ids": [str(person.id)], "department": None},
        format="json",
    )
    assert response.status_code == 200, response.content
    person.refresh_from_db()
    assert person.department_id is None


def test_bulk_department_reports_clashes_instead_of_failing_the_batch():
    """One person already in the destination must not 500 the other 199."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    dest = models.Department.objects.create(organization=org, name="Eng")

    clasher_user = factories.UserFactory()
    # Already sits in the destination via another membership row…
    _member(org, clasher_user, department=dest, is_primary=True)
    # …and this is the row we try to move there.
    clasher = _member(org, clasher_user, is_primary=False)
    movable = _member(org)

    response = client.post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {"ids": [str(clasher.id), str(movable.id)], "department": str(dest.id)},
        format="json",
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["moved"] == 1
    assert len(body["skipped"]) == 1
    assert body["skipped"][0]["reason"] == "already_in_department"


def test_bulk_department_rejects_other_orgs_department():
    org, other = factories.OrganizationFactory(), factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    foreign = models.Department.objects.create(organization=other, name="Theirs")
    person = _member(org)

    response = client.post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {"ids": [str(person.id)], "department": str(foreign.id)},
        format="json",
    )
    assert response.status_code == 400


def test_bulk_is_capped():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    dept = models.Department.objects.create(organization=org, name="Eng")

    response = client.post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {
            "ids": [str(factories.UserFactory().id) for _ in range(201)],
            "department": str(dept.id),
        },
        format="json",
    )
    assert response.status_code == 400, "one request must not rewrite a whole org"


def test_bulk_writes_one_audit_row_not_one_per_member():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    dept = models.Department.objects.create(organization=org, name="Eng")
    people = [_member(org) for _ in range(5)]

    client.post(
        "/api/v1.0/admin/memberships/bulk-department/",
        {"ids": [str(m.id) for m in people], "department": str(dept.id)},
        format="json",
    )
    rows = models.AuditLog.objects.filter(
        organization=org, action=models.AuditActionChoices.MEMBER_BULK_UPDATE
    )
    assert rows.count() == 1
    assert len(rows.first().metadata["moved"]) == 5


# --- bulk offboard -----------------------------------------------------------


def test_bulk_offboard_marks_everyone_left():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    people = [_member(org) for _ in range(3)]

    with mock.patch(PATCH_DISABLE):
        response = client.post(
            "/api/v1.0/admin/memberships/bulk-offboard/",
            {"ids": [str(m.id) for m in people], "reason": "layoff"},
            format="json",
        )
    assert response.status_code == 200, response.content
    assert response.json()["offboarded"] == 3
    for m in people:
        m.refresh_from_db()
        assert m.status == LEFT


def test_bulk_offboard_skips_guarded_members_and_keeps_going():
    """A department head in the batch is reported, not allowed to abort it."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    head_user = factories.UserFactory()
    head = _member(org, user=head_user)
    models.Department.objects.create(organization=org, name="Eng", head=head_user)
    ordinary = _member(org)

    with mock.patch(PATCH_DISABLE):
        response = client.post(
            "/api/v1.0/admin/memberships/bulk-offboard/",
            {"ids": [str(head.id), str(ordinary.id)]},
            format="json",
        )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["offboarded"] == 1
    assert len(body["skipped"]) == 1

    head.refresh_from_db()
    ordinary.refresh_from_db()
    assert head.status == ACTIVE
    assert ordinary.status == LEFT


def test_bulk_offboard_cannot_remove_the_last_owner():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org, org_role=ADMIN)
    sole_owner = _member(org, org_role=OWNER)

    with mock.patch(PATCH_DISABLE):
        response = client.post(
            "/api/v1.0/admin/memberships/bulk-offboard/",
            {"ids": [str(sole_owner.id)]},
            format="json",
        )
    assert response.status_code == 200, response.content
    assert response.json()["offboarded"] == 0
    sole_owner.refresh_from_db()
    assert sole_owner.status == ACTIVE


def test_plain_member_cannot_bulk():
    org = factories.OrganizationFactory()
    plain = factories.UserFactory()
    _member(org, plain, org_role=MEMBER)
    client = APIClient()
    client.force_login(plain)

    response = client.post(
        "/api/v1.0/admin/memberships/bulk-offboard/", {"ids": []}, format="json"
    )
    assert response.status_code == 403


# --- dictionaries ------------------------------------------------------------


def test_dictionary_lists_seeded_employee_types():
    org = factories.OrganizationFactory()
    ensure_builtin_dict_items(org)
    client, _admin = _admin_client(org)

    response = client.get("/api/v1.0/admin/dictionaries/?scope=employee_type")
    assert response.status_code == 200, response.content
    codes = {row["code"] for row in response.json()}
    assert codes == {"formal", "intern", "outsourced", "dispatch", "consultant"}


def test_dictionary_create_and_scope_filter():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)

    created = client.post(
        "/api/v1.0/admin/dictionaries/",
        {"scope": "job_level", "code": "p5", "label": "P5"},
        format="json",
    )
    assert created.status_code == 201, created.content

    assert len(client.get("/api/v1.0/admin/dictionaries/?scope=job_level").json()) == 1
    assert (
        len(client.get("/api/v1.0/admin/dictionaries/?scope=employee_type").json()) == 0
    )


def test_builtin_label_can_be_renamed_but_code_cannot():
    org = factories.OrganizationFactory()
    ensure_builtin_dict_items(org)
    client, _admin = _admin_client(org)
    item = models.OrgDictItem.objects.get(organization=org, code="intern")

    renamed = client.patch(
        f"/api/v1.0/admin/dictionaries/{item.id}/", {"label": "实习生"}, format="json"
    )
    assert renamed.status_code == 200, renamed.content
    item.refresh_from_db()
    assert item.label == "实习生"

    recoded = client.patch(
        f"/api/v1.0/admin/dictionaries/{item.id}/", {"code": "trainee"}, format="json"
    )
    assert recoded.status_code == 400, "code is what logic branches on"


def test_builtin_cannot_be_deleted():
    org = factories.OrganizationFactory()
    ensure_builtin_dict_items(org)
    client, _admin = _admin_client(org)
    item = models.OrgDictItem.objects.get(organization=org, code="formal")

    response = client.delete(f"/api/v1.0/admin/dictionaries/{item.id}/")
    assert response.status_code == 400
    assert models.OrgDictItem.objects.filter(id=item.id).exists()


def test_option_in_use_cannot_be_deleted():
    """Deleting an option someone holds would orphan their profile silently."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    item = models.OrgDictItem.objects.create(
        organization=org, scope="job_level", code="p5", label="P5"
    )
    _member(org, job_level=item)

    response = client.delete(f"/api/v1.0/admin/dictionaries/{item.id}/")
    assert response.status_code == 400
    assert "still use this option" in str(response.content)


def test_unused_custom_option_can_be_deleted():
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    item = models.OrgDictItem.objects.create(
        organization=org, scope="job_level", code="p9", label="P9"
    )

    assert (
        client.delete(f"/api/v1.0/admin/dictionaries/{item.id}/").status_code == 204
    )


def test_dictionary_is_org_scoped():
    org, other = factories.OrganizationFactory(), factories.OrganizationFactory()
    ensure_builtin_dict_items(other)
    client, _admin = _admin_client(org)

    assert client.get("/api/v1.0/admin/dictionaries/").json() == []


# --- membership write path uses the dictionary --------------------------------


def test_membership_accepts_employee_type_from_own_org():
    org = factories.OrganizationFactory()
    ensure_builtin_dict_items(org)
    client, _admin = _admin_client(org)
    person = _member(org)
    formal = models.OrgDictItem.objects.get(organization=org, code="formal")

    response = client.patch(
        f"/api/v1.0/admin/memberships/{person.id}/",
        {"employee_type": str(formal.id), "work_city": "深圳", "employee_no": "E1"},
        format="json",
    )
    assert response.status_code == 200, response.content
    person.refresh_from_db()
    assert person.employee_type_id == formal.id
    assert person.work_city == "深圳"


def test_membership_rejects_option_from_the_wrong_dictionary():
    """A job_level option must not be accepted as an employee_type."""
    org = factories.OrganizationFactory()
    client, _admin = _admin_client(org)
    person = _member(org)
    level = models.OrgDictItem.objects.create(
        organization=org, scope="job_level", code="p5", label="P5"
    )

    response = client.patch(
        f"/api/v1.0/admin/memberships/{person.id}/",
        {"employee_type": str(level.id)},
        format="json",
    )
    assert response.status_code == 400
    assert "employee_type" in response.json()


def test_members_filterable_by_employee_type():
    org = factories.OrganizationFactory()
    ensure_builtin_dict_items(org)
    client, _admin = _admin_client(org)
    formal = models.OrgDictItem.objects.get(organization=org, code="formal")
    intern = models.OrgDictItem.objects.get(organization=org, code="intern")
    _member(org, employee_type=formal)
    _member(org, employee_type=intern)

    rows = client.get(
        f"/api/v1.0/admin/memberships/?employee_type={formal.id}"
    ).json()["results"]
    assert len(rows) == 1
    assert rows[0]["employee_type"]["code"] == "formal"
