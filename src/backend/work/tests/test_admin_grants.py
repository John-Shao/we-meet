"""Customer-side Work seat admin API (P1-A, acceptance §3.2–§3.4)."""

import threading
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.db import connections
from django.utils import timezone
from django.utils.dateparse import parse_datetime

import pytest
from rest_framework.test import APIClient

from core import factories
from core import models as core_models

from work import api_admin, grants
from work.models import (
    WorkAccessAudit,
    WorkMemberGrant,
    WorkOrganizationEntitlement,
)

pytestmark = pytest.mark.django_db

ACTIVE = core_models.MembershipStatusChoices.ACTIVE
LEFT = core_models.MembershipStatusChoices.LEFT
GRANTS = "/api/v1.0/work/admin/grants/"
SUMMARY = "/api/v1.0/work/admin/grants/summary/"
ENTITLEMENT = "/api/v1.0/work/admin/entitlement/"
READ = "org.work_grant.read"
WRITE = "org.work_grant.write"


def _org(*, entitled=True, enabled=True, member_limit=None):
    organization = factories.OrganizationFactory()
    if entitled:
        WorkOrganizationEntitlement.objects.create(
            organization=organization,
            enabled=enabled,
            member_limit=member_limit,
        )
    return organization


def _membership(  # noqa: PLR0913 - mirrors the fields each test varies
    organization,
    *,
    user=None,
    department=None,
    status=ACTIVE,
    org_role=core_models.OrgRoleChoices.MEMBER,
    is_primary=True,
    employee_no="",
):
    user = user or factories.UserFactory()
    membership = core_models.Membership.objects.create(
        organization=organization,
        user=user,
        department=department,
        status=status,
        org_role=org_role,
        is_primary=is_primary,
        employee_no=employee_no,
    )
    return user, membership


def _department(organization, name=None):
    return factories.DepartmentFactory(
        organization=organization, name=name or f"Dept {uuid.uuid4().hex[:5]}"
    )


def _owner(organization):
    user, _membership_row = _membership(
        organization, org_role=core_models.OrgRoleChoices.OWNER
    )
    return user


def _role(organization, membership, *permissions, scope=None):
    role = core_models.AdminRole.objects.create(
        organization=organization,
        code=f"role-{uuid.uuid4().hex[:8]}",
        name="Role",
        permissions=list(permissions),
    )
    assignment = core_models.AdminRoleAssignment.objects.create(
        role=role,
        membership=membership,
        scope_type=(
            core_models.AdminScopeChoices.DEPARTMENTS
            if scope is not None
            else core_models.AdminScopeChoices.ALL
        ),
    )
    if scope is not None:
        core_models.AdminRoleScopeDepartment.objects.create(
            assignment=assignment, department=scope
        )
    return role


def _scoped_admin(organization, department, *permissions):
    user, membership = _membership(organization, department=department)
    _role(organization, membership, *permissions, scope=department)
    return user


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _member_path(user):
    return f"{GRANTS}{user.id}/"


def _restore_path(user):
    return f"{GRANTS}{user.id}/restore/"


# ---- permission / tenant gates ------------------------------------------------


def test_missing_read_permission_names_the_code():
    organization = _org()
    user, _ = _membership(organization)

    response = _client(user).get(GRANTS)

    assert response.status_code == 403
    assert response.json() == {
        "code": "missing_permission",
        "meta": {"permission": READ},
    }
    assert _client(user).get(SUMMARY).status_code == 403
    assert _client(user).get(ENTITLEMENT).status_code == 403


def test_read_role_lists_but_cannot_write():
    organization = _org()
    admin, membership = _membership(organization)
    _role(organization, membership, READ)
    target, _ = _membership(organization)
    client = _client(admin)

    assert client.get(GRANTS).status_code == 200
    for response in (
        client.post(GRANTS, {"user_id": str(target.id)}, format="json"),
        client.delete(_member_path(target)),
        client.post(_restore_path(target), {}, format="json"),
    ):
        assert response.status_code == 403
        assert response.json() == {
            "code": "missing_permission",
            "meta": {"permission": WRITE},
        }


def test_cross_tenant_header_is_rejected_without_leaking():
    organization = _org()
    owner = _owner(organization)
    other = _org()
    other_user, _ = _membership(other)
    grants.grant_member(organization_id=other.id, user_id=other_user.id)
    client = _client(owner)

    response = client.get(GRANTS, HTTP_X_ORGANIZATION_ID=str(other.id))

    assert response.status_code == 403
    assert response.json()["code"] == "organization_mismatch"
    assert str(other_user.id) not in response.content.decode()

    malformed = client.get(GRANTS, HTTP_X_ORGANIZATION_ID="not-a-uuid")
    assert malformed.status_code == 403
    assert malformed.json()["code"] == "organization_mismatch"


def test_scoped_admin_sees_and_writes_only_their_subtree():
    organization = _org()
    department = _department(organization)
    other_department = _department(organization)
    admin = _scoped_admin(organization, department, READ, WRITE)
    inside, _ = _membership(organization, department=department)
    outside, _ = _membership(organization, department=other_department)
    grants.grant_member(organization_id=organization.id, user_id=inside.id)
    grants.grant_member(organization_id=organization.id, user_id=outside.id)
    client = _client(admin)

    results = client.get(GRANTS).json()["results"]
    assert [row["user_id"] for row in results] == [str(inside.id)]

    for response in (
        client.post(GRANTS, {"user_id": str(outside.id)}, format="json"),
        client.delete(_member_path(outside)),
        client.post(_restore_path(outside), {}, format="json"),
    ):
        assert response.status_code == 403
        assert response.json()["code"] == "member_out_of_scope"


def test_a_secondary_department_row_puts_a_person_in_scope():
    """Scope is per-row EXISTS, not the primary membership's department."""
    organization = _org()
    department = _department(organization)
    admin = _scoped_admin(organization, department, READ, WRITE)
    user = factories.UserFactory()
    core_models.Membership.objects.create(
        organization=organization, user=user, department=None, is_primary=True
    )
    core_models.Membership.objects.create(
        organization=organization,
        user=user,
        department=department,
        is_primary=False,
    )

    client = _client(admin)
    assert (
        client.post(GRANTS, {"user_id": str(user.id)}, format="json").status_code == 201
    )
    results = client.get(GRANTS).json()["results"]
    assert [row["user_id"] for row in results] == [str(user.id)]


def test_a_departmentless_member_is_outside_a_scoped_admin():
    organization = _org()
    department = _department(organization)
    admin = _scoped_admin(organization, department, READ, WRITE)
    org_level = factories.UserFactory()
    core_models.Membership.objects.create(
        organization=organization, user=org_level, department=None, is_primary=True
    )

    client = _client(admin)
    assert client.get(GRANTS).json()["results"] == []
    response = client.post(GRANTS, {"user_id": str(org_level.id)}, format="json")
    assert response.status_code == 403
    assert response.json()["code"] == "member_out_of_scope"


def test_a_foreign_user_is_out_of_scope_for_scoped_admins_and_not_active_elsewhere():
    organization = _org()
    department = _department(organization)
    admin = _scoped_admin(organization, department, READ, WRITE)
    foreign, _ = _membership(_org())

    scoped = _client(admin).post(GRANTS, {"user_id": str(foreign.id)}, format="json")
    assert scoped.status_code == 403
    assert scoped.json()["code"] == "member_out_of_scope"
    assert str(foreign.id) not in scoped.content.decode()

    owner = _owner(organization)
    unscoped = _client(owner).post(GRANTS, {"user_id": str(foreign.id)}, format="json")
    assert unscoped.status_code == 409
    assert unscoped.json()["code"] == "member_not_active"


def test_suspended_organization_blocks_reads_and_writes():
    organization = _org()
    owner = _owner(organization)
    target, _ = _membership(organization)
    organization.is_active = False
    organization.save(update_fields=["is_active"])
    client = _client(owner)

    for path in (GRANTS, SUMMARY, ENTITLEMENT):
        response = client.get(path)
        assert response.status_code == 403
        assert response.json()["code"] == "organization_suspended"

    for response in (
        client.post(GRANTS, {"user_id": str(target.id)}, format="json"),
        client.delete(_member_path(target)),
        client.post(_restore_path(target), {}, format="json"),
    ):
        assert response.status_code == 403
        assert response.json()["code"] == "organization_suspended"


@pytest.mark.parametrize("entitled,enabled", [(False, None), (True, False)])
def test_reads_work_without_entitlement_but_granting_is_rejected(entitled, enabled):
    organization = _org(
        entitled=entitled,
        enabled=True if enabled is None else enabled,
    )
    owner = _owner(organization)
    target, _ = _membership(organization)
    client = _client(owner)

    assert client.get(GRANTS).status_code == 200
    assert client.get(SUMMARY).json() == {
        "active": 0,
        "limit": None,
        "over_limit": False,
    }
    assert client.get(ENTITLEMENT).json()["enabled"] is False

    response = client.post(GRANTS, {"user_id": str(target.id)}, format="json")
    assert response.status_code == 409
    assert response.json()["code"] == "org_disabled"


def test_entitlement_is_a_read_only_snapshot_of_the_platform_settings():
    organization = _org(member_limit=7)
    owner = _owner(organization)
    WorkOrganizationEntitlement.objects.filter(organization=organization).update(
        features={"documents": True}, daily_token_budget=12345
    )
    client = _client(owner)

    assert client.get(ENTITLEMENT).json() == {
        "enabled": True,
        "features": {"documents": True},
        "daily_token_budget": 12345,
        "member_limit": 7,
    }
    assert client.post(ENTITLEMENT, {}, format="json").status_code == 405


def test_summary_reports_a_legacy_over_limit_without_revoking():
    """Shrinking the limit below current seats is a display problem, not a
    reason to silently take access away from people."""
    organization = _org(member_limit=2)
    owner = _owner(organization)
    for _ in range(2):
        member, _ = _membership(organization)
        grants.grant_member(organization_id=organization.id, user_id=member.id)
    WorkOrganizationEntitlement.objects.filter(organization=organization).update(
        member_limit=1
    )

    assert _client(owner).get(SUMMARY).json() == {
        "active": 2,
        "limit": 1,
        "over_limit": True,
    }
    assert (
        WorkMemberGrant.objects.filter(
            organization=organization, revoked_at__isnull=True
        ).count()
        == 2
    )


def test_archived_organization_is_read_only():
    organization = _org()
    owner = _owner(organization)
    target, _ = _membership(organization)
    grants.grant_member(organization_id=organization.id, user_id=target.id)
    organization.is_active = False
    organization.archived_at = timezone.now()
    organization.save(update_fields=["is_active", "archived_at"])
    client = _client(owner)

    assert client.get(GRANTS).status_code == 200
    for response in (
        client.post(GRANTS, {"user_id": str(target.id)}, format="json"),
        client.delete(_member_path(target)),
        client.post(_restore_path(target), {}, format="json"),
    ):
        assert response.status_code == 403
        assert response.json()["code"] == "organization_read_only"


# ---- seat semantics -----------------------------------------------------------


def test_member_limit_meta_is_numeric_on_the_wire():
    organization = _org(member_limit=2)
    owner = _owner(organization)
    for _ in range(2):
        member, _ = _membership(organization)
        grants.grant_member(organization_id=organization.id, user_id=member.id)
    third, _ = _membership(organization)

    response = _client(owner).post(GRANTS, {"user_id": str(third.id)}, format="json")

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "member_limit_reached"
    assert body["meta"] == {"limit": 2, "active": 2}
    assert isinstance(body["meta"]["limit"], int)
    assert not WorkMemberGrant.objects.filter(user=third).exists()


def test_repeat_grant_is_idempotent_and_audits_an_update():
    organization = _org(member_limit=1)
    owner = _owner(organization)
    target, _ = _membership(organization)
    client = _client(owner)

    first = client.post(GRANTS, {"user_id": str(target.id)}, format="json")
    second = client.post(GRANTS, {"user_id": str(target.id)}, format="json")

    assert (first.status_code, second.status_code) == (201, 200)
    assert WorkMemberGrant.objects.filter(organization=organization).count() == 1
    assert grants.active_seats(organization.id) == 1
    assert WorkAccessAudit.objects.filter(action="grant_updated").count() == 1


def test_multi_department_member_is_counted_and_paged_once():
    organization = _org()
    owner = _owner(organization)
    first_department = _department(organization)
    second_department = _department(organization)
    user = factories.UserFactory()
    core_models.Membership.objects.create(
        organization=organization,
        user=user,
        department=first_department,
        is_primary=True,
    )
    core_models.Membership.objects.create(
        organization=organization,
        user=user,
        department=second_department,
        is_primary=False,
    )
    other, _ = _membership(organization, department=first_department)
    grants.grant_member(organization_id=organization.id, user_id=user.id)
    grants.grant_member(organization_id=organization.id, user_id=other.id)
    client = _client(owner)

    body = client.get(GRANTS).json()
    assert body["count"] == 2

    page_one = client.get(GRANTS, {"page_size": 1}).json()["results"]
    page_two = client.get(GRANTS, {"page_size": 1, "page": 2}).json()["results"]
    ids = [row["user_id"] for row in page_one + page_two]
    assert len(ids) == len(set(ids)) == 2


def test_status_precedence_is_deterministic():
    organization = _org()
    owner = _owner(organization)
    now = timezone.now()
    states = {}
    for name, values in (
        ("active", {"enabled": True}),
        ("expired", {"enabled": True, "expires_at": now - timedelta(days=1)}),
        (
            "disabled",
            {"enabled": False, "expires_at": now - timedelta(days=1)},
        ),
        ("revoked", {"enabled": False, "revoked_at": now}),
    ):
        user, _ = _membership(organization)
        WorkMemberGrant.objects.create(organization=organization, user=user, **values)
        states[str(user.id)] = name

    results = _client(owner).get(GRANTS).json()["results"]
    assert {row["user_id"]: row["status"] for row in results} == states


def test_membership_state_prefers_any_active_row():
    """One active row anywhere in the org means the person still works here."""
    organization = _org()
    owner = _owner(organization)
    person, _ = _membership(organization)
    stale = core_models.Membership.objects.create(
        organization=organization,
        user=person,
        department=_department(organization),
        is_primary=False,
    )
    core_models.Membership.objects.filter(pk=stale.pk).update(
        status=LEFT, left_at=timezone.now() - timedelta(days=30)
    )
    grants.grant_member(organization_id=organization.id, user_id=person.id)

    row = _client(owner).get(GRANTS).json()["results"][0]

    assert row["membership_state"] == "active"
    assert row["left_at"] is None


def test_membership_state_left_reports_the_latest_departure():
    """The badge exists to show 'left, but the seat is still held'."""
    organization = _org()
    owner = _owner(organization)
    person = factories.UserFactory()
    first = _membership(organization, user=person)[1]
    second = core_models.Membership.objects.create(
        organization=organization,
        user=person,
        department=_department(organization),
        is_primary=False,
    )
    grants.grant_member(organization_id=organization.id, user_id=person.id)
    older = timezone.now() - timedelta(days=40)
    newer = timezone.now() - timedelta(days=5)
    core_models.Membership.objects.filter(pk=first.pk).update(
        status=LEFT, left_at=older
    )
    core_models.Membership.objects.filter(pk=second.pk).update(
        status=LEFT, left_at=newer
    )

    row = _client(owner).get(GRANTS).json()["results"][0]

    # The grant is deliberately untouched: only the service revokes on departure.
    assert row["status"] == "active"
    assert row["membership_state"] == "left"
    assert parse_datetime(row["left_at"]) == newer


def test_membership_state_falls_back_to_the_latest_non_left_status():
    organization = _org()
    owner = _owner(organization)
    person = factories.UserFactory()
    first = _membership(organization, user=person)[1]
    second = core_models.Membership.objects.create(
        organization=organization,
        user=person,
        department=_department(organization),
        is_primary=False,
    )
    grants.grant_member(organization_id=organization.id, user_id=person.id)
    core_models.Membership.objects.filter(pk=first.pk).update(
        status=core_models.MembershipStatusChoices.INVITED,
        updated_at=timezone.now() - timedelta(days=2),
    )
    core_models.Membership.objects.filter(pk=second.pk).update(
        status=core_models.MembershipStatusChoices.SUSPENDED,
        updated_at=timezone.now() - timedelta(days=1),
    )

    row = _client(owner).get(GRANTS).json()["results"][0]

    assert row["membership_state"] == "suspended"
    assert row["left_at"] is None


def test_list_and_summary_use_the_same_expiry_clock():
    organization = _org(member_limit=3)
    owner = _owner(organization)
    user, _ = _membership(organization)
    expires_at = timezone.now() + timedelta(minutes=5)
    grants.grant_member(
        organization_id=organization.id,
        user_id=user.id,
        expires_at=expires_at,
    )
    client = _client(owner)

    with patch(
        "django.utils.timezone.now",
        return_value=expires_at - timedelta(seconds=1),
    ):
        row = client.get(GRANTS).json()["results"][0]
        summary = client.get(SUMMARY).json()
    assert row["status"] == "active"
    assert summary["active"] == 1

    with patch(
        "django.utils.timezone.now",
        return_value=expires_at + timedelta(seconds=1),
    ):
        row = client.get(GRANTS).json()["results"][0]
        summary = client.get(SUMMARY).json()
    assert row["status"] == "expired"
    assert summary["active"] == 0


def test_search_never_matches_email_or_phone():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization, employee_no="E-778899")
    user.full_name = "Alice Zhang"
    user.short_name = "Alice"
    user.email = "alice@secret.example"
    user.phone = "+8613800001111"
    user.save()
    grants.grant_member(organization_id=organization.id, user_id=user.id)
    client = _client(owner)

    def ids(query):
        body = client.get(GRANTS, {"q": query}).json()
        return [row["user_id"] for row in body["results"]]

    assert ids("alice@secret") == []
    assert ids("13800001111") == []
    assert ids("Alice") == [str(user.id)]
    assert ids("E-778899") == [str(user.id)]
    assert ids(str(user.id)[:8]) == [str(user.id)]
    # A prefix crossing a dash boundary still matches when pasted without it.
    compact = str(user.id).replace("-", "")
    assert ids(compact[:10]) == [str(user.id)]


def test_display_name_never_falls_back_to_email():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization)
    user.full_name = ""
    user.short_name = ""
    user.email = "leak-me@example.com"
    user.save()
    grants.grant_member(organization_id=organization.id, user_id=user.id)

    response = _client(owner).get(GRANTS)

    row = response.json()["results"][0]
    assert row["display_name"] == user.sub
    assert "leak-me@example.com" not in response.content.decode()


def test_revoke_is_idempotent_and_keeps_the_first_timestamp():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization)
    client = _client(owner)
    assert (
        client.post(GRANTS, {"user_id": str(user.id)}, format="json").status_code == 201
    )

    assert client.delete(_member_path(user)).status_code == 204
    first = WorkMemberGrant.objects.get(user=user)
    assert first.revoked_reason == "manual"
    assert grants.active_seats(organization.id) == 0

    assert client.delete(_member_path(user)).status_code == 204
    second = WorkMemberGrant.objects.get(user=user)
    assert second.revoked_at == first.revoked_at
    assert WorkAccessAudit.objects.filter(action="grant_revoked").count() == 1


def test_restore_over_the_limit_keeps_the_revocation():
    organization = _org(member_limit=1)
    owner = _owner(organization)
    first, _ = _membership(organization)
    second, _ = _membership(organization)
    grants.grant_member(organization_id=organization.id, user_id=first.id)
    grants.revoke_member_grant(organization_id=organization.id, user_id=first.id)
    grants.grant_member(organization_id=organization.id, user_id=second.id)

    response = _client(owner).post(_restore_path(first), {}, format="json")

    assert response.status_code == 409
    assert response.json()["code"] == "member_limit_reached"
    grant = WorkMemberGrant.objects.get(user=first)
    assert grant.revoked_at is not None
    assert grant.is_active() is False


def test_departed_member_cannot_be_granted_and_unknown_grants_are_reported():
    organization = _org()
    owner = _owner(organization)
    departed, membership = _membership(organization)
    core_models.Membership.objects.filter(pk=membership.pk).update(status=LEFT)
    client = _client(owner)

    response = client.post(GRANTS, {"user_id": str(departed.id)}, format="json")
    assert response.status_code == 409
    assert response.json()["code"] == "member_not_active"

    # Revocation never asks about membership state; only the row has to exist.
    response = client.delete(_member_path(departed))
    assert response.status_code == 409
    assert response.json()["code"] == "grant_not_found"
    # Restore does ask: handing a seat back to someone who has left would
    # re-spend the tenant's money. That gate fires before the row lookup.
    response = client.post(_restore_path(departed), {}, format="json")
    assert response.status_code == 409
    assert response.json()["code"] == "member_not_active"


def test_restoring_a_grant_that_does_not_exist_is_reported():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization)

    response = _client(owner).post(_restore_path(user), {}, format="json")

    assert response.status_code == 409
    assert response.json()["code"] == "grant_not_found"


def test_expired_grant_is_listed_and_releases_its_seat():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization)
    grants.grant_member(
        organization_id=organization.id,
        user_id=user.id,
        expires_at=timezone.now() - timedelta(minutes=1),
    )
    client = _client(owner)

    row = client.get(GRANTS).json()["results"][0]
    assert row["status"] == "expired"
    assert client.get(SUMMARY).json()["active"] == 0
    assert grants.active_seats(organization.id) == 0


@pytest.mark.django_db(transaction=True)
def test_concurrent_requests_take_exactly_one_last_seat():
    organization = _org(member_limit=1)
    owner = _owner(organization)
    people = [_membership(organization)[0] for _ in range(5)]
    clients = [_client(owner) for _ in people]
    barrier = threading.Barrier(len(people))
    outcomes = []
    lock = threading.Lock()

    def claim(index, user_id):
        try:
            barrier.wait(timeout=10)
            response = clients[index].post(
                GRANTS, {"user_id": str(user_id)}, format="json"
            )
            result = response.status_code
        except Exception as exc:  # noqa: BLE001 -- surfaced by the assertion
            result = type(exc).__name__
        finally:
            connections.close_all()
        with lock:
            outcomes.append(result)

    threads = [
        threading.Thread(target=claim, args=(index, person.id))
        for index, person in enumerate(people)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert outcomes.count(201) == 1, outcomes
    assert outcomes.count(409) == 4, outcomes
    assert grants.active_seats(organization.id) == 1


# ---- audit attribution --------------------------------------------------------


def test_writes_attribute_the_caller_and_truncate_the_request_id():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization)
    client = _client(owner)

    client.post(
        GRANTS,
        {"user_id": str(user.id)},
        format="json",
        HTTP_X_REQUEST_ID="r" * 80,
    )
    created = WorkAccessAudit.objects.get(action="grant_created")
    assert created.actor_id == owner.id
    assert len(created.request_id) == 64

    client.delete(_member_path(user), HTTP_X_REQUEST_ID="req-revoke")
    revoked = WorkAccessAudit.objects.get(action="grant_revoked")
    assert revoked.actor_id == owner.id
    assert WorkMemberGrant.objects.get(user=user).revoked_by_id == owner.id

    client.post(_restore_path(user), {}, format="json", HTTP_X_REQUEST_ID="req-restore")
    restored = WorkAccessAudit.objects.get(action="grant_restored")
    assert restored.request_id == "req-restore"


def test_audit_failure_never_blocks_the_grant():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization)

    with patch.object(
        WorkAccessAudit.objects, "create", side_effect=RuntimeError("audit down")
    ):
        response = _client(owner).post(GRANTS, {"user_id": str(user.id)}, format="json")

    assert response.status_code == 201
    assert WorkMemberGrant.objects.filter(user=user).exists()
    assert "audit down" not in response.content.decode()


def test_audit_failure_during_revocation_does_not_revive_the_seat():
    organization = _org()
    owner = _owner(organization)
    user, _ = _membership(organization)
    client = _client(owner)
    assert (
        client.post(GRANTS, {"user_id": str(user.id)}, format="json").status_code == 201
    )

    with patch.object(
        WorkAccessAudit.objects, "create", side_effect=RuntimeError("audit down")
    ):
        response = client.delete(_member_path(user))

    assert response.status_code == 204
    grant = WorkMemberGrant.objects.get(user=user)
    assert grant.revoked_at is not None
    assert grant.is_active() is False
    assert client.get(GRANTS).json()["results"][0]["status"] == "revoked"
    assert client.get(SUMMARY).json()["active"] == 0


def test_the_api_never_writes_grants_directly():
    source = Path(api_admin.__file__).read_text(encoding="utf-8")
    for token in (
        "WorkMemberGrant.objects.create",
        "WorkMemberGrant.objects.update",
        "WorkMemberGrant.objects.delete",
        ".save(",
        ".delete()",
        "str(user)",
    ):
        assert token not in source
