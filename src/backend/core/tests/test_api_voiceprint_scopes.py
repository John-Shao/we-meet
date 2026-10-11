"""Membership-scoped metadata for personal settings, without directory leakage."""

from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_voiceprint_consent import enabled, profile_for

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/voiceprint/scopes/"


def test_only_own_active_orgs_with_minimal_policy_and_role():
    user = UserFactory()
    allowed = OrganizationFactory(
        name="Own", settings={"voiceprint": {"enabled": True, "version": 4}}
    )
    MembershipFactory(
        user=user, organization=allowed, org_role=models.OrgRoleChoices.ADMIN
    )
    MembershipFactory(user=user, organization=OrganizationFactory(is_active=False))
    MembershipFactory(user=UserFactory(), organization=OrganizationFactory())
    inactive = MembershipFactory(user=user, organization=OrganizationFactory())
    inactive.status = models.MembershipStatusChoices.LEFT
    inactive.save(update_fields=["status"])
    response = client_for(user).get(URL)
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    assert response.data == {
        "results": [
            {
                "id": str(allowed.pk),
                "name": "Own",
                "can_manage_policy": True,
                "policy": {"enabled": True, "version": 4},
            }
        ],
        "next_offset": None,
    }


def test_default_disabled_and_paginated_without_creating_consent():
    user = UserFactory()
    for index in range(27):
        MembershipFactory(
            user=user, organization=OrganizationFactory(name=f"Org {index:02d}")
        )
    first = client_for(user).get(URL).data
    second = client_for(user).get(URL, {"offset": first["next_offset"]}).data
    assert len(first["results"]) == 25 and len(second["results"]) == 2
    assert second["next_offset"] is None
    assert all(
        not row["can_manage_policy"]
        and row["policy"] == {"enabled": False, "version": 0}
        for row in first["results"]
    )
    assert not models.VoiceprintConsent.objects.filter(user=user).exists()


def test_bounds_unknown_filters_and_anonymous_rejected():
    user = UserFactory()
    assert APIClient().get(URL).status_code in (401, 403)
    for query in (
        {"offset": -1},
        {"offset": 10001},
        {"user_id": str(user.pk)},
        {"organization_id": "other"},
    ):
        assert client_for(user).get(URL, query).status_code == 400


def test_departure_and_account_deactivation_rechecked():
    user = UserFactory()
    row = MembershipFactory(user=user)
    client = client_for(user)
    assert len(client.get(URL).data["results"]) == 1
    row.delete()
    assert client.get(URL).data["results"] == []
    user.is_active = False
    user.save(update_fields=["is_active"])
    assert client.get(URL).status_code in (401, 403)


def test_expected_owner_header_fences_cookie_account_change():
    user = UserFactory()
    client = client_for(user)
    assert client.get(URL, HTTP_X_VOICEPRINT_OWNER=str(user.pk)).status_code == 200
    assert client.get(URL, HTTP_X_VOICEPRINT_OWNER=str(uuid4())).status_code == 401
    response = client.patch(
        "/api/v1.0/voiceprint/settings/",
        {
            "organization_id": None,
            "expected_version": 0,
            "allow_enrollment": True,
        },
        format="json",
        HTTP_X_VOICEPRINT_OWNER=str(uuid4()),
    )
    assert (
        response.status_code == 401
        and response.data["code"] == "voiceprint_account_changed"
    )
    assert not models.VoiceprintConsent.objects.filter(user=user).exists()


def test_deletion_list_ownership_and_survives_consent_removal(enabled):
    user, other = UserFactory(), UserFactory()
    profile = profile_for(user)
    client = client_for(user)
    deleted = client.delete(
        f"/api/v1.0/voiceprint/profiles/{profile.pk}/",
        {
            "expected_version": 1,
            "request_key": str(uuid4()),
        },
        format="json",
    )
    assert deleted.status_code == 202
    receipt = client.get("/api/v1.0/voiceprint/deletions/")
    assert (
        receipt.status_code == 200 and receipt["Cache-Control"] == "private, no-store"
    )
    assert receipt.data == {"results": [deleted.data], "next_offset": None}
    assert (
        client_for(other).get("/api/v1.0/voiceprint/deletions/").data["results"] == []
    )
    profile.consent.delete()
    assert deleted.data["id"] in {
        row["id"]
        for row in client.get("/api/v1.0/voiceprint/deletions/").data["results"]
    }


def test_deletion_list_separates_scopes_and_paginates():
    user = UserFactory()
    membership = MembershipFactory(user=user)
    for _index in range(27):
        models.VoiceprintDeletionJob.objects.create(
            owner_id=user.pk,
            request_key=uuid4(),
            expected_version=1,
            revoked_generation=1,
        )
    organization = models.VoiceprintDeletionJob.objects.create(
        owner_id=user.pk,
        organization_id=membership.organization_id,
        request_key=uuid4(),
        expected_version=1,
        revoked_generation=1,
    )
    client = client_for(user)
    path = "/api/v1.0/voiceprint/deletions/"
    first = client.get(path).data
    second = client.get(path, {"offset": first["next_offset"]}).data
    assert len(first["results"]) == 25 and len(second["results"]) == 2
    assert second["next_offset"] is None
    scoped = client.get(path, {"organization_id": str(membership.organization_id)}).data
    assert [row["id"] for row in scoped["results"]] == [str(organization.pk)]


def test_browser_preflight_allows_voiceprint_headers_for_configured_origin(settings):
    settings.CORS_ALLOW_ALL_ORIGINS = False
    settings.CORS_ALLOWED_ORIGINS = ["https://voiceprint-ui.test"]
    response = APIClient().options(
        URL,
        HTTP_ORIGIN="https://voiceprint-ui.test",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="PUT",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="content-type,x-voiceprint-owner,x-voiceprint-upload-token",
    )
    assert response.status_code == 200
    allowed = {
        header.strip() for header in response["Access-Control-Allow-Headers"].split(",")
    }
    assert {"x-voiceprint-owner", "x-voiceprint-upload-token"} <= allowed
