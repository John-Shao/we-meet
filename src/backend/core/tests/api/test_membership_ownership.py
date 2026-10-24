"""HTTP tests for transfer-owner and the membership write guards (P0-1)."""

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
OWNER = models.OrgRoleChoices.OWNER
ADMIN = models.OrgRoleChoices.ADMIN
MEMBER = models.OrgRoleChoices.MEMBER


def _member(org, user=None, *, role=MEMBER, status=ACTIVE, primary=True):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        org_role=role,
        status=status,
        is_primary=primary,
    )


def _client_for(membership):
    client = APIClient()
    client.force_login(membership.user)
    return client


def _field_message(body, field):
    value = body[field]
    return str(value[0]) if isinstance(value, list) else str(value)


def _transfer(client, target):
    return client.post(
        f"/api/v1.0/admin/memberships/{target.id}/transfer-owner/",
        {},
        format="json",
    )


@pytest.fixture
def org():
    return factories.OrganizationFactory()


def test_owner_can_transfer_ownership(org):
    actor = _member(org, role=OWNER)
    target = _member(org, role=MEMBER)

    response = _transfer(_client_for(actor), target)

    assert response.status_code == 200, response.content
    assert response.json()["transferred"] is True
    assert response.json()["target"]["org_role"] == OWNER
    assert response.json()["actor"]["org_role"] == ADMIN
    actor.refresh_from_db()
    target.refresh_from_db()
    assert (actor.org_role, target.org_role) == (ADMIN, OWNER)
    assert models.AuditLog.objects.filter(
        action=models.AuditActionChoices.MEMBER_OWNER_TRANSFERRED
    ).exists()


def test_admin_cannot_transfer_ownership(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=MEMBER)

    response = _transfer(_client_for(actor), target)

    assert response.status_code == 403
    assert response.json()["code"] == "not_organization_owner"


def test_owner_patch_grants_co_owner_and_audits(org):
    actor = _member(org, role=OWNER)
    target = _member(org, role=MEMBER)

    response = _client_for(actor).patch(
        f"/api/v1.0/admin/memberships/{target.id}/",
        {"org_role": OWNER},
        format="json",
    )

    assert response.status_code == 200, response.content
    target.refresh_from_db()
    assert target.org_role == OWNER
    audit = models.AuditLog.objects.get(
        action=models.AuditActionChoices.MEMBER_ROLE_CHANGE,
        target_id=str(target.id),
    )
    assert audit.metadata["ownership_changed"] is True


def test_admin_cannot_patch_owner(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=MEMBER)

    response = _client_for(actor).patch(
        f"/api/v1.0/admin/memberships/{target.id}/",
        {"org_role": OWNER},
        format="json",
    )

    assert response.status_code == 400
    assert "active owner" in _field_message(response.json(), "org_role")


def test_admin_cannot_demote_owner(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=OWNER)

    response = _client_for(actor).patch(
        f"/api/v1.0/admin/memberships/{target.id}/",
        {"org_role": MEMBER},
        format="json",
    )

    assert response.status_code == 400
    target.refresh_from_db()
    assert target.org_role == OWNER


def test_fourth_owner_is_rejected(org):
    actor = _member(org, role=OWNER)
    _member(org, role=OWNER)
    _member(org, role=OWNER)
    target = _member(org, role=MEMBER)

    response = _client_for(actor).patch(
        f"/api/v1.0/admin/memberships/{target.id}/",
        {"org_role": OWNER},
        format="json",
    )

    assert response.status_code == 400
    assert "at most 3 active owners" in _field_message(response.json(), "org_role")


def test_patch_status_left_is_rejected(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=MEMBER)

    response = _client_for(actor).patch(
        f"/api/v1.0/admin/memberships/{target.id}/",
        {"status": models.MembershipStatusChoices.LEFT},
        format="json",
    )

    assert response.status_code == 400
    assert "offboard" in _field_message(response.json(), "status").lower()


def test_create_owner_is_rejected(org):
    actor = _member(org, role=OWNER)

    response = _client_for(actor).post(
        "/api/v1.0/admin/memberships/",
        {"user": str(factories.UserFactory().id), "org_role": OWNER},
        format="json",
    )

    assert response.status_code == 400
    assert "org_role" in response.json()


def test_delete_membership_is_method_not_allowed(org):
    actor = _member(org, role=ADMIN)
    target = _member(org, role=MEMBER)

    response = _client_for(actor).delete(
        f"/api/v1.0/admin/memberships/{target.id}/"
    )

    assert response.status_code == 405
    assert models.Membership.objects.filter(id=target.id).exists()
