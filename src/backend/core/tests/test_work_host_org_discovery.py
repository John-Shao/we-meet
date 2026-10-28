"""Host OrgDiscovery wire (HW-03): orgs and members with revision cursors."""

import uuid

from django.test import override_settings
from django.utils import timezone

import pytest

from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.models import Membership, Organization, User
from core.tests.host_mtls import (
    CA_PEM,
    CLIENT_PEM,
    IDENTITY,
    OTHER_CN_PEM,
    cert_headers,
)

pytestmark = pytest.mark.django_db

ORGS_URL = "/work-host/v2/orgs"
MEMBERS_URL = "/work-host/v2/orgs/{}/members"
ORG_KEYS = {"org_id", "name", "status", "home_region", "revision", "gaps"}
MEMBER_KEYS = {"subject_id", "status", "role", "work_seat", "revision", "gaps"}


def _get(client, url, **params):
    response = client.get(url, data=params, **cert_headers(CLIENT_PEM))
    assert response.status_code == 200, response.content
    return response.json()


def _collect(client, url, limit, **params):
    items, cursor = [], None
    while True:
        query = dict(params, limit=limit)
        if cursor is not None:
            query["cursor"] = cursor
        payload = _get(client, url, **query)
        items.extend(payload["items"])
        cursor = payload["next_cursor"]
        if cursor is None:
            return items


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_org_list_projects_status_region_and_revision(client):
    active = OrganizationFactory(name="Acme")
    suspended = OrganizationFactory(name="Beta", is_active=False)
    archived = OrganizationFactory(name="Gamma", is_active=False)
    Organization.objects.filter(pk=archived.pk).update(archived_at=timezone.now())

    payload = _get(client, ORGS_URL, limit=100)

    items = {item["org_id"]: item for item in payload["items"]}
    assert {str(active.id), str(suspended.id), str(archived.id)} <= set(items)
    assert all(set(item) == ORG_KEYS for item in items.values())
    assert items[str(active.id)] == {
        "org_id": str(active.id),
        "name": "Acme",
        "status": "active",
        "home_region": "cn-north",
        "revision": 1,
        "gaps": [],
    }
    assert items[str(suspended.id)]["status"] == "suspended"
    assert items[str(archived.id)]["status"] == "archived"
    assert items[str(archived.id)]["revision"] == 2
    assert payload["next_cursor"] is None


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_org_list_reports_gaps_instead_of_guessing(client):
    organization = OrganizationFactory(name="Acme")
    Organization.objects.filter(pk=organization.pk).update(home_region="CN")

    items = _get(client, ORGS_URL, limit=100)["items"]
    item = next(item for item in items if item["org_id"] == str(organization.id))

    assert item["home_region"] == "CN"
    assert item["gaps"] == ["home_region"]
    assert item["revision"] == 2


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_org_list_paginates_by_opaque_cursor(client):
    organizations = [OrganizationFactory() for _ in range(3)]

    first = _get(client, ORGS_URL, limit=2)
    assert len(first["items"]) == 2
    assert first["next_cursor"]

    collected = [item["org_id"] for item in first["items"]]
    cursor = first["next_cursor"]
    while cursor is not None:
        payload = _get(client, ORGS_URL, limit=2, cursor=cursor)
        collected.extend(item["org_id"] for item in payload["items"])
        cursor = payload["next_cursor"]

    assert len(collected) == len(set(collected))
    assert {str(organization.id) for organization in organizations} <= set(collected)
    assert set(collected) == {
        str(pk) for pk in Organization.objects.values_list("id", flat=True)
    }


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
@pytest.mark.parametrize(
    "params",
    [
        {"limit": "0"},
        {"limit": "101"},
        {"limit": "abc"},
        {"cursor": "not-a-cursor"},
    ],
)
def test_org_list_rejects_invalid_pagination(client, params):
    OrganizationFactory()

    response = client.get(ORGS_URL, data=params, **cert_headers(CLIENT_PEM))

    assert response.status_code == 422
    assert response.json() == {"code": "invalid_pagination"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_member_list_projects_role_seat_and_status(client):
    organization = OrganizationFactory()
    owner = UserFactory(sub="user-owner")
    admin = UserFactory(sub="user-admin")
    dept_admin = UserFactory(sub="user-dept-admin")
    member = UserFactory(sub="user-member")
    MembershipFactory(
        organization=organization,
        user=owner,
        org_role="owner",
        work_seat=True,
    )
    MembershipFactory(organization=organization, user=admin, org_role="administrator")
    MembershipFactory(organization=organization, user=dept_admin, org_role="dept_admin")
    left = MembershipFactory(organization=organization, user=member, org_role="member")
    Membership.objects.filter(pk=left.pk).update(status="left")

    payload = _get(client, MEMBERS_URL.format(organization.id), limit=100)

    items = {item["subject_id"]: item for item in payload["items"]}
    assert set(items) == {"user-owner", "user-admin", "user-dept-admin", "user-member"}
    assert all(set(item) == MEMBER_KEYS for item in items.values())
    assert items["user-owner"]["status"] == "active"
    assert items["user-owner"]["role"] == "owner"
    assert items["user-owner"]["work_seat"] is True
    assert items["user-owner"]["gaps"] == []
    assert items["user-admin"]["role"] == "admin"
    assert items["user-admin"]["work_seat"] is False
    assert items["user-dept-admin"]["role"] == "member"
    assert items["user-member"]["status"] == "left"
    active_revisions = {
        items[subject]["revision"]
        for subject in ("user-owner", "user-admin", "user-dept-admin")
    }
    assert len(active_revisions) == 3
    assert active_revisions <= {2, 3, 4, 5}
    assert items["user-member"]["revision"] == 6
    assert payload["next_cursor"] is None


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_member_list_reports_gaps_instead_of_guessing(client):
    organization = OrganizationFactory()
    user = UserFactory()
    membership = MembershipFactory(organization=organization, user=user)
    User.objects.filter(pk=user.pk).update(sub="")
    Membership.objects.filter(pk=membership.pk).update(org_role="ghost")

    item = _get(client, MEMBERS_URL.format(organization.id))["items"][0]

    assert item["subject_id"] == ""
    assert item["role"] is None
    assert item["gaps"] == ["subject_id", "role"]


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_member_list_filters_by_revision_after(client):
    organization = OrganizationFactory()
    MembershipFactory(organization=organization, user=UserFactory(sub="rev-1"))
    second = MembershipFactory(organization=organization, user=UserFactory(sub="rev-2"))
    third = MembershipFactory(organization=organization, user=UserFactory(sub="rev-3"))
    Membership.objects.filter(pk=second.pk).update(title="bump")
    Membership.objects.filter(pk=third.pk).update(title="bump-1")
    Membership.objects.filter(pk=third.pk).update(title="bump-2")

    def subjects(revision_after):
        payload = _get(
            client,
            MEMBERS_URL.format(organization.id),
            revision_after=revision_after,
        )
        return {item["subject_id"] for item in payload["items"]}

    revisions = {
        item["subject_id"]: item["revision"]
        for item in _get(client, MEMBERS_URL.format(organization.id))["items"]
    }
    assert len(set(revisions.values())) == 3
    for subject, revision in revisions.items():
        assert subject in subjects(revision - 1)
        assert subject not in subjects(revision)
    assert subjects(0) == {"rev-1", "rev-2", "rev-3"}
    assert subjects(max(revisions.values())) == set()


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_member_list_paginates_by_opaque_cursor(client):
    organization = OrganizationFactory()
    for index in range(3):
        MembershipFactory(
            organization=organization, user=UserFactory(sub=f"paged-{index}")
        )

    items = _collect(client, MEMBERS_URL.format(organization.id), limit=2)

    subjects = [item["subject_id"] for item in items]
    assert len(subjects) == len(set(subjects)) == 3
    assert set(subjects) == {"paged-0", "paged-1", "paged-2"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
def test_member_list_rejects_unknown_organization(client):
    response = client.get(MEMBERS_URL.format(uuid.uuid4()), **cert_headers(CLIENT_PEM))

    assert response.status_code == 404
    assert response.json() == {"code": "org_not_found"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
@pytest.mark.parametrize(
    "params",
    [{"revision_after": "-1"}, {"revision_after": "abc"}, {"limit": "0"}],
)
def test_member_list_rejects_invalid_parameters(client, params):
    organization = OrganizationFactory()

    response = client.get(
        MEMBERS_URL.format(organization.id),
        data=params,
        **cert_headers(CLIENT_PEM),
    )

    assert response.status_code == 422
    assert response.json() == {"code": "invalid_pagination"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM, WORK_HOST_MTLS_CLIENT_IDENTITY=IDENTITY
)
@pytest.mark.parametrize(
    "url", [ORGS_URL, MEMBERS_URL.format("117d1112-aa41-4a14-a629-a0c382c0e86f")]
)
@pytest.mark.parametrize("headers", [{}, cert_headers(OTHER_CN_PEM)])
def test_org_discovery_requires_workload_certificate(client, url, headers):
    response = client.get(url, **headers)

    assert response.status_code == 403
    assert response.json() == {"code": "client_identity_invalid"}
