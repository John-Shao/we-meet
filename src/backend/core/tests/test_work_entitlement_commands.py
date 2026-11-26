import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from django.db import transaction
from django.test import override_settings

import pytest
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.test import APIClient

from core import factories, models
from core.services import work_governance
from core.tests.host_mtls import (
    CA_PEM,
    CLIENT_PEM,
    GOVERNANCE_CLIENT_PEM,
    OPERATOR_CLIENT_PEM,
    cert_headers,
)

pytestmark = pytest.mark.django_db

APPLY_URL = "/work-host/v3/organizations/{org_id}/work-entitlement-commands"
GET_URL = "/work-host/v3/work-entitlement-commands/{command_id}"
EVENTS_URL = "/work-host/v3/governance-events"
MTLS = {
    "WORK_HOST_MTLS_CA_PEM": CA_PEM,
    "WORK_HOST_MTLS_CLIENT_IDENTITY": "work-control-plane",
    "WORK_HOST_GOVERNANCE_EVENTS_IDENTITY": "work-governance-events",
    "WORK_HOST_ENTITLEMENT_IDENTITY": "work-operator-adapter",
}


def command_body(  # noqa: PLR0913 -- explicit command matrix
    organization,
    *,
    command_id=None,
    expected=0,
    target=1,
    enabled=True,
    seat_limit=2,
    suspended=False,
    authorization="OPS-42",
):
    command_id = command_id or uuid.uuid4()
    payload_hash = work_governance.execution_entitlement_payload_hash(
        organization_id=organization.id,
        expected_revision=expected,
        target_revision=target,
        enabled=enabled,
        seat_limit=seat_limit,
        operator_suspended=suspended,
        operator_authorization_ref=authorization,
    )
    return {
        "command_id": str(command_id),
        "expected_entitlement_revision": expected,
        "target_entitlement_revision": target,
        "enabled": enabled,
        "seat_limit": seat_limit,
        "operator_suspended": suspended,
        "operator_authorization_ref": authorization,
        "payload_hash": payload_hash,
    }


@override_settings(**MTLS)
def test_entitlement_apply_replay_get_and_governance_event(client):
    organization = factories.OrganizationFactory()
    body = command_body(organization)
    url = APPLY_URL.format(org_id=organization.id)

    response = client.post(
        url,
        json.dumps(body),
        content_type="application/json",
        **cert_headers(OPERATOR_CLIENT_PEM),
    )
    assert response.status_code == 200, response.content
    assert response.json()["status"] == "applied"
    assert response.json()["revision"] == 1
    assert response.json()["occupied_seats"] == 0

    replay = client.post(
        url,
        json.dumps(body),
        content_type="application/json",
        **cert_headers(OPERATOR_CLIENT_PEM),
    )
    assert replay.status_code == 200, replay.content
    assert replay.json()["status"] == "replayed"
    assert (
        models.WorkGovernanceEvent.objects.filter(
            organization=organization, kind="entitlement"
        ).count()
        == 1
    )
    entitlement = models.WorkExecutionEntitlement.objects.get(organization=organization)
    assert (entitlement.enabled, entitlement.seat_limit, entitlement.revision) == (
        True,
        2,
        1,
    )

    fetched = client.get(
        GET_URL.format(command_id=body["command_id"]),
        **cert_headers(OPERATOR_CLIENT_PEM),
    )
    assert fetched.status_code == 200, fetched.content
    assert fetched.json()["status"] == "applied"
    assert fetched.json()["payload_hash"] == body["payload_hash"]

    events = client.get(
        EVENTS_URL,
        data={"org_id": str(organization.id)},
        **cert_headers(GOVERNANCE_CLIENT_PEM),
    )
    assert events.status_code == 200, events.content
    event = events.json()["events"][0]
    assert event["kind"] == "entitlement"
    assert event["desired"] is True
    assert event["org_revision"] == 1
    assert event["command_id"] == body["command_id"]


@override_settings(**MTLS)
def test_entitlement_rejects_forgery_conflict_and_stale_revision(client):
    organization = factories.OrganizationFactory()
    url = APPLY_URL.format(org_id=organization.id)
    body = command_body(organization)
    assert (
        client.post(
            url,
            json.dumps(body),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )

    forged = {**body, "payload_hash": "sha256:" + "b" * 64}
    assert client.post(
        url,
        json.dumps(forged),
        content_type="application/json",
        **cert_headers(OPERATOR_CLIENT_PEM),
    ).json() == {"code": "invalid_request"}

    conflict = command_body(
        organization, command_id=uuid.UUID(body["command_id"]), seat_limit=3
    )
    response = client.post(
        url,
        json.dumps(conflict),
        content_type="application/json",
        **cert_headers(OPERATOR_CLIENT_PEM),
    )
    assert response.status_code == 409
    assert response.json() == {"code": "idempotency_key_conflict"}

    stale = command_body(organization, expected=0, target=2)
    response = client.post(
        url,
        json.dumps(stale),
        content_type="application/json",
        **cert_headers(OPERATOR_CLIENT_PEM),
    )
    assert response.status_code == 409
    assert response.json() == {"code": "governance_revision_conflict"}
    assert (
        models.WorkGovernanceEvent.objects.filter(organization=organization).count()
        == 1
    )


@override_settings(**MTLS)
def test_entitlement_operator_identity_is_dedicated(client):
    organization = factories.OrganizationFactory()
    response = client.post(
        APPLY_URL.format(org_id=organization.id),
        json.dumps(command_body(organization)),
        content_type="application/json",
        **cert_headers(CLIENT_PEM),
    )
    assert response.status_code == 403
    assert response.json() == {"code": "client_identity_invalid"}
    assert not models.WorkExecutionEntitlement.objects.exists()
    assert not models.WorkGovernanceEvent.objects.exists()


@override_settings(**MTLS)
def test_change_seat_enforces_entitlement_and_counts_people(client):
    organization = factories.OrganizationFactory()
    first = factories.MembershipFactory(organization=organization)
    second = factories.MembershipFactory(organization=organization)

    with pytest.raises(DRFValidationError) as incomplete:
        work_governance.change_seat(first, desired=True)
    assert incomplete.value.detail == {"code": "entitlement_incomplete"}

    url = APPLY_URL.format(org_id=organization.id)
    disabled = command_body(organization, enabled=False)
    assert (
        client.post(
            url,
            json.dumps(disabled),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )
    with pytest.raises(DRFValidationError) as denied:
        work_governance.change_seat(first, desired=True)
    assert denied.value.detail == {"code": "org_execution_disabled"}

    suspended = command_body(
        organization, expected=1, target=2, enabled=True, suspended=True
    )
    assert (
        client.post(
            url,
            json.dumps(suspended),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )
    with pytest.raises(DRFValidationError) as denied:
        work_governance.change_seat(first, desired=True)
    assert denied.value.detail == {"code": "org_execution_disabled"}

    enabled = command_body(
        organization, expected=2, target=3, enabled=True, seat_limit=1
    )
    assert (
        client.post(
            url,
            json.dumps(enabled),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )
    work_governance.change_seat(first, desired=True)
    with pytest.raises(DRFValidationError) as full:
        work_governance.change_seat(second, desired=True)
    assert full.value.detail == {"code": "seat_limit_reached"}
    work_governance.change_seat(first, desired=True)
    first.refresh_from_db()
    assert first.work_seat is True


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(("enabled", "suspended"), [(False, False), (True, True)])
@override_settings(**MTLS)
def test_operator_disable_or_suspension_serializes_before_a_concurrent_seat_grant(
    client, enabled, suspended
):
    organization = factories.OrganizationFactory()
    target = factories.MembershipFactory(organization=organization)
    initial = command_body(organization)
    assert (
        client.post(
            APPLY_URL.format(org_id=organization.id),
            json.dumps(initial),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )

    started = threading.Event()

    def grant_seat():
        started.set()
        try:
            work_governance.change_seat(target, desired=True)
        except DRFValidationError as error:
            return error
        return None

    with ThreadPoolExecutor(max_workers=1) as executor:
        with transaction.atomic():
            locked = models.Organization.objects.select_for_update().get(
                pk=organization.pk
            )
            pending = executor.submit(grant_seat)
            assert started.wait(timeout=5)
            disabled = command_body(
                organization,
                expected=1,
                target=2,
                enabled=enabled,
                suspended=suspended,
            )
            work_governance.apply_execution_entitlement(
                locked,
                command_id=disabled["command_id"],
                expected_revision=disabled["expected_entitlement_revision"],
                target_revision=disabled["target_entitlement_revision"],
                enabled=disabled["enabled"],
                seat_limit=disabled["seat_limit"],
                operator_suspended=disabled["operator_suspended"],
                operator_authorization_ref=disabled["operator_authorization_ref"],
                payload_hash=disabled["payload_hash"],
            )
        error = pending.result(timeout=5)

    assert isinstance(error, DRFValidationError)
    assert error.detail == {"code": "org_execution_disabled"}
    target.refresh_from_db()
    assert target.work_seat is False
    entitlement = models.WorkExecutionEntitlement.objects.get(organization=organization)
    assert (
        entitlement.enabled,
        entitlement.operator_suspended,
        entitlement.revision,
    ) == (enabled, suspended, 2)


@override_settings(**MTLS)
def test_native_membership_api_cannot_grant_seat_while_disabled(client):
    organization = factories.OrganizationFactory()
    actor = factories.UserFactory()
    factories.MembershipFactory(
        organization=organization,
        user=actor,
        org_role=models.OrgRoleChoices.ADMIN,
        is_primary=True,
    )
    target = factories.MembershipFactory(organization=organization)
    admin_client = APIClient()
    admin_client.force_login(actor)
    disabled = command_body(organization, enabled=False)
    assert (
        client.post(
            APPLY_URL.format(org_id=organization.id),
            json.dumps(disabled),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )

    response = admin_client.patch(
        f"/api/v1.0/admin/memberships/{target.id}/",
        {"work_seat": True},
        format="json",
    )
    assert response.status_code == 400, response.content
    assert response.json() == {"code": "org_execution_disabled"}
    target.refresh_from_db()
    assert target.work_seat is False
    assert not models.WorkGovernanceEvent.objects.filter(
        organization=organization, kind="seat"
    ).exists()


@override_settings(**MTLS)
def test_lowering_seat_limit_never_revokes_an_existing_seat(client):
    organization = factories.OrganizationFactory()
    first = factories.MembershipFactory(organization=organization)
    second = factories.MembershipFactory(organization=organization)
    url = APPLY_URL.format(org_id=organization.id)
    initial = command_body(organization, seat_limit=2)
    assert (
        client.post(
            url,
            json.dumps(initial),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )
    work_governance.change_seat(first, desired=True)
    work_governance.change_seat(second, desired=True)
    lowered = command_body(organization, expected=1, target=2, seat_limit=1)
    assert (
        client.post(
            url,
            json.dumps(lowered),
            content_type="application/json",
            **cert_headers(OPERATOR_CLIENT_PEM),
        ).status_code
        == 200
    )
    assert (
        models.Membership.objects.filter(
            organization=organization, work_seat=True
        ).count()
        == 2
    )
    with pytest.raises(DRFValidationError) as full:
        work_governance.change_seat(
            factories.MembershipFactory(organization=organization), desired=True
        )
    assert full.value.detail == {"code": "seat_limit_reached"}
