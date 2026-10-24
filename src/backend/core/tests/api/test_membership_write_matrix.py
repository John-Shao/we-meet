"""Every write path that used to be able to produce an OWNER (P0-1).

The console member PATCH / create / DELETE cases live in
``test_membership_ownership.py``; this file covers the remaining entrances:
invite links, join approval, CSV import, rehire and Django admin.
"""

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core import admin as core_admin
from core import factories, models
from core.services import member_import, offboarding

pytestmark = pytest.mark.django_db

LEFT = models.MembershipStatusChoices.LEFT
OWNER = models.OrgRoleChoices.OWNER
ADMIN = models.OrgRoleChoices.ADMIN
MEMBER = models.OrgRoleChoices.MEMBER


def _member(org, user=None, **kw):
    return models.Membership.objects.create(
        organization=org,
        user=user or factories.UserFactory(),
        is_primary=kw.pop("is_primary", True),
        **kw,
    )


def _client_for(membership):
    client = APIClient()
    client.force_login(membership.user)
    return client


def test_invite_link_cannot_grant_owner():
    org = factories.OrganizationFactory()
    actor = _member(org, org_role=ADMIN)

    response = _client_for(actor).post(
        "/api/v1.0/admin/invite-links/",
        {"org_role": OWNER},
        format="json",
    )

    assert response.status_code == 400
    assert "org_role" in response.json()


def test_rehire_defaults_to_member():
    org = factories.OrganizationFactory()
    actor = _member(org, org_role=ADMIN)
    departed = _member(org, org_role=OWNER, status=LEFT, is_primary=False)

    with mock.patch("core.tasks.offboarding.enable_keycloak_login") as task:
        task.delay = mock.Mock()
        response = _client_for(actor).post(
            f"/api/v1.0/admin/memberships/{departed.id}/rehire/",
            {},
            format="json",
        )

    assert response.status_code == 200, response.content
    departed.refresh_from_db()
    assert departed.status == models.MembershipStatusChoices.ACTIVE
    assert departed.org_role == MEMBER


def test_rehire_cannot_restore_owner():
    org = factories.OrganizationFactory()
    actor = _member(org, org_role=ADMIN)
    departed = _member(org, org_role=OWNER, status=LEFT, is_primary=False)

    response = _client_for(actor).post(
        f"/api/v1.0/admin/memberships/{departed.id}/rehire/",
        {"org_role": OWNER},
        format="json",
    )

    assert response.status_code == 400
    departed.refresh_from_db()
    assert departed.status == LEFT


def test_offboarding_service_rejects_owner_rehire():
    org = factories.OrganizationFactory()
    actor = _member(org, org_role=ADMIN)
    departed = _member(org, org_role=OWNER, status=LEFT, is_primary=False)

    with pytest.raises(offboarding.OffboardError):
        offboarding.rehire_membership(departed, actor=actor.user, org_role=OWNER)


def test_csv_import_rejects_owner_row():
    org = factories.OrganizationFactory()
    _member(org, org_role=ADMIN)
    csv_text = "email,full_name,org_role\r\nsomeone@example.com,Someone,owner\r\n"

    _headers, rows = member_import.parse_csv(csv_text)
    results = member_import.preflight(org, rows, False)

    assert results[0].action == member_import.ACTION_ERROR
    assert results[0].errors


def test_django_admin_cannot_edit_or_delete_membership():
    field_names = core_admin.MembershipAdmin.list_editable
    assert "org_role" not in field_names
    assert "status" not in field_names

    model_admin = core_admin.MembershipAdmin(models.Membership, None)
    assert model_admin.has_delete_permission(mock.Mock(), None) is False

    readonly = core_admin.MembershipAdmin.readonly_fields
    assert "org_role" in readonly
    assert "status" in readonly
