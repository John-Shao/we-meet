import uuid
from datetime import datetime, timedelta
from unittest import mock

from django.contrib import admin
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError, transaction
from django.test import RequestFactory, override_settings
from django.utils import timezone

import pytest
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.test import APIClient

from core import factories, models
from core.admin import MembershipAdmin
from core.services import work_governance
from core.services.offboarding import offboard_membership
from core.tests.host_mtls import (
    CA_PEM,
    CLIENT_PEM,
    GOVERNANCE_CLIENT_PEM,
    cert_headers,
)

pytestmark = pytest.mark.django_db

EVENTS_URL = "/work-host/v3/governance-events"


def _event_payload(client, organization, **params):
    response = client.get(
        EVENTS_URL,
        data={"org_id": str(organization.id), **params},
        **cert_headers(GOVERNANCE_CLIENT_PEM),
    )
    assert response.status_code == 200, response.content
    return response.json()


def _admin_client(organization):
    actor = factories.UserFactory()
    factories.MembershipFactory(
        organization=organization,
        user=actor,
        org_role=models.OrgRoleChoices.ADMIN,
        is_primary=True,
    )
    client = APIClient()
    client.force_login(actor)
    return client, actor


def _enable_seats(organization, limit=100):
    models.WorkExecutionEntitlement.objects.update_or_create(
        organization=organization,
        defaults={
            "enabled": True,
            "seat_limit": limit,
            "operator_suspended": False,
            "revision": 1,
        },
    )


def test_seat_events_use_independent_org_sequences_and_atomic_audit():
    first_org = factories.OrganizationFactory()
    second_org = factories.OrganizationFactory()
    _enable_seats(first_org)
    _enable_seats(second_org)
    user = factories.UserFactory(sub="seat-user")
    first = factories.MembershipFactory(
        organization=first_org, user=user, is_primary=True
    )
    second = factories.MembershipFactory(
        organization=first_org, user=user, department=None
    )
    other = factories.MembershipFactory(organization=second_org)

    granted = work_governance.change_seat(first, desired=True)
    assert granted.member_revision == max(
        models.Membership.objects.filter(organization=first_org, user=user).values_list(
            "directory_revision", flat=True
        )
    )
    revoked = work_governance.change_seat(first, desired=False)
    first_org.refresh_from_db()
    first_directory_revision = first_org.directory_revision
    other_granted = work_governance.change_seat(other, desired=True)

    assert (granted.event_seq, revoked.event_seq, other_granted.event_seq) == (1, 2, 1)
    assert granted.organization_id == first_org.id
    assert other_granted.organization_id == second_org.id
    first_org.refresh_from_db()
    assert first_org.directory_revision == first_directory_revision
    assert not models.Membership.objects.filter(
        organization=first_org, user=user, work_seat=True
    ).exists()
    audit = models.AuditLog.objects.get(
        organization=first_org,
        metadata__command_id=str(revoked.command_id),
    )
    assert audit.metadata["event_seq"] == 2
    assert audit.metadata["work_seat"] == {"from": True, "to": False}


def test_seat_command_rejects_a_forged_payload_hash():
    membership = factories.MembershipFactory()
    with pytest.raises(DRFValidationError):
        work_governance.change_seat(
            membership, desired=True, payload_hash="sha256:" + "b" * 64
        )
    assert not models.WorkGovernanceEvent.objects.exists()


def test_seat_command_replay_and_payload_conflict():
    membership = factories.MembershipFactory()
    _enable_seats(membership.organization)
    command_id = uuid.uuid4()

    first = work_governance.change_seat(membership, desired=True, command_id=command_id)
    replay = work_governance.change_seat(
        membership, desired=True, command_id=command_id
    )
    assert replay.id == first.id
    assert models.WorkGovernanceEvent.objects.count() == 1

    with pytest.raises(work_governance.GovernanceConflict):
        work_governance.change_seat(membership, desired=False, command_id=command_id)
    assert models.WorkGovernanceEvent.objects.count() == 1


def test_seat_event_rows_are_immutable():
    membership = factories.MembershipFactory()
    _enable_seats(membership.organization)
    event = work_governance.change_seat(membership, desired=True)

    with pytest.raises(DatabaseError):
        with transaction.atomic():
            models.WorkGovernanceEvent.objects.filter(pk=event.pk).update(desired=False)
    with pytest.raises(DatabaseError):
        with transaction.atomic():
            models.WorkGovernanceEvent.objects.filter(pk=event.pk).delete()


def test_seat_change_rolls_back_when_audit_write_fails():
    membership = factories.MembershipFactory()
    _enable_seats(membership.organization)
    with mock.patch.object(
        models.AuditLog.objects, "create", side_effect=RuntimeError("audit failed")
    ):
        with pytest.raises(RuntimeError):
            work_governance.change_seat(membership, desired=True)

    membership.refresh_from_db()
    assert membership.work_seat is False
    assert not models.WorkGovernanceEvent.objects.exists()
    assert not models.WorkGovernanceSequence.objects.exists()


@override_settings(OIDC_OP_JWKS_ENDPOINT="https://idp.example.test/jwks")
def test_membership_api_seat_patch_produces_event():
    organization = factories.OrganizationFactory()
    _enable_seats(organization)
    client, _actor = _admin_client(organization)
    membership = factories.MembershipFactory(organization=organization)

    response = client.patch(
        f"/api/v1.0/admin/memberships/{membership.id}/",
        {"work_seat": True},
        format="json",
    )

    assert response.status_code == 200, response.content
    membership.refresh_from_db()
    assert membership.work_seat is True
    event = models.WorkGovernanceEvent.objects.get(organization=organization)
    assert event.kind == "seat"
    assert event.desired is True
    assert event.target_subject_id == membership.user.sub


def test_django_admin_seat_change_uses_the_same_producer():
    organization = factories.OrganizationFactory()
    _enable_seats(organization)
    actor = factories.UserFactory(is_staff=True, is_superuser=True)
    membership = factories.MembershipFactory(organization=organization)
    membership.work_seat = True
    request = RequestFactory().post("/dj-admin/core/membership/")
    request.user = actor
    model_admin = MembershipAdmin(models.Membership, admin.site)

    model_admin.save_model(request, membership, None, True)

    membership.refresh_from_db()
    assert membership.work_seat is True
    assert (
        models.WorkGovernanceEvent.objects.filter(
            organization=organization, desired=True
        ).count()
        == 1
    )


def test_django_admin_create_without_seat_does_not_revoke_existing_seat():
    organization = factories.OrganizationFactory()
    actor = factories.UserFactory(is_staff=True, is_superuser=True)
    existing = factories.MembershipFactory(
        organization=organization, work_seat=True, is_primary=True
    )
    added = factories.MembershipFactory(
        organization=organization, user=existing.user, department=None
    )
    request = RequestFactory().post("/dj-admin/core/membership/")
    request.user = actor
    model_admin = MembershipAdmin(models.Membership, admin.site)

    model_admin.save_model(request, added, None, False)

    existing.refresh_from_db()
    added.refresh_from_db()
    assert existing.work_seat is True
    assert added.work_seat is False
    assert not models.WorkGovernanceEvent.objects.exists()


def test_last_membership_offboard_revokes_seat_in_the_same_transaction():
    organization = factories.OrganizationFactory()
    membership = factories.MembershipFactory(
        organization=organization, work_seat=True, is_primary=True
    )

    offboard_membership(membership, actor=None, disable_login=False)

    membership.refresh_from_db()
    assert membership.status == models.MembershipStatusChoices.LEFT
    assert membership.work_seat is False
    event = models.WorkGovernanceEvent.objects.get(organization=organization)
    assert event.desired is False
    assert event.member_revision == membership.directory_revision
    audit = models.AuditLog.objects.get(
        organization=organization,
        metadata__command_id=str(event.command_id),
    )
    assert audit.metadata["work_seat"] == {"from": True, "to": False}


def test_anonymized_seat_holder_can_offboard_without_a_forged_event():
    organization = factories.OrganizationFactory()
    membership = factories.MembershipFactory(
        organization=organization, work_seat=True, is_primary=True
    )
    models.User.objects.filter(pk=membership.user_id).update(sub="")

    offboard_membership(membership, actor=None, disable_login=False)

    membership.refresh_from_db()
    assert membership.status == models.MembershipStatusChoices.LEFT
    assert membership.work_seat is False
    assert not models.WorkGovernanceEvent.objects.exists()
    audit = models.AuditLog.objects.get(
        organization=organization,
        metadata__reason="subject_unreadable",
    )
    assert audit.metadata["governance_event"] == "not_emitted"


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM,
    WORK_HOST_MTLS_CLIENT_IDENTITY="work-control-plane",
    WORK_HOST_GOVERNANCE_EVENTS_IDENTITY="work-governance-events",
)
def test_governance_endpoint_requires_its_dedicated_identity(client):
    organization = factories.OrganizationFactory()
    response = client.get(
        EVENTS_URL,
        data={"org_id": str(organization.id)},
        **cert_headers(CLIENT_PEM),
    )
    assert response.status_code == 403
    assert response.json() == {"code": "client_identity_invalid"}


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM,
    WORK_HOST_MTLS_CLIENT_IDENTITY="work-control-plane",
    WORK_HOST_GOVERNANCE_EVENTS_IDENTITY="work-governance-events",
)
def test_governance_endpoint_empty_paginated_and_cursor_contract(client):
    organization = factories.OrganizationFactory()
    _enable_seats(organization)
    empty = _event_payload(client, organization)
    assert empty == {"events": [], "latest_event_seq": 0, "gap": None}

    first = factories.MembershipFactory(organization=organization)
    second = factories.MembershipFactory(organization=organization)
    work_governance.change_seat(first, desired=True)
    work_governance.change_seat(second, desired=True)

    page = _event_payload(client, organization, limit=1)
    assert set(page) == {"events", "latest_event_seq", "gap"}
    assert page["latest_event_seq"] == 2
    assert page["gap"] is None
    assert len(page["events"]) == 1
    assert page["events"][0]["event_seq"] == 1
    assert set(page["events"][0]) == {
        "event_seq",
        "command_id",
        "kind",
        "target_subject_id",
        "desired",
        "payload_hash",
        "member_revision",
        "org_revision",
        "permissions_revision",
        "applied_at",
    }
    second_page = _event_payload(client, organization, after_event_seq=1, limit=1)
    assert [event["event_seq"] for event in second_page["events"]] == [2]


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM,
    WORK_HOST_MTLS_CLIENT_IDENTITY="work-control-plane",
    WORK_HOST_GOVERNANCE_EVENTS_IDENTITY="work-governance-events",
)
def test_governance_event_older_than_365_days_remains_readable(client):
    organization = factories.OrganizationFactory()
    _enable_seats(organization)
    membership = factories.MembershipFactory(organization=organization)
    applied_at = timezone.now().replace(microsecond=0) - timedelta(days=366)

    with mock.patch(
        "core.services.work_governance.timezone.now", return_value=applied_at
    ):
        event = work_governance.change_seat(membership, desired=True)

    payload = _event_payload(client, organization)

    assert event.applied_at == applied_at
    assert payload["latest_event_seq"] == 1
    assert payload["gap"] is None
    assert [item["command_id"] for item in payload["events"]] == [str(event.command_id)]
    returned_at = datetime.fromisoformat(
        payload["events"][0]["applied_at"].replace("Z", "+00:00")
    )
    assert returned_at == applied_at


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM,
    WORK_HOST_MTLS_CLIENT_IDENTITY="work-control-plane",
    WORK_HOST_GOVERNANCE_EVENTS_IDENTITY="work-governance-events",
)
def test_governance_gap_alerts_but_keeps_the_read_port_open(client, caplog):
    organization = factories.OrganizationFactory()
    _enable_seats(organization)
    membership = factories.MembershipFactory(organization=organization)
    work_governance.change_seat(membership, desired=True)
    models.WorkGovernanceSequence.objects.filter(organization=organization).update(
        last_event_seq=3
    )

    payload = _event_payload(client, organization)

    assert payload["latest_event_seq"] == 3
    assert [event["event_seq"] for event in payload["events"]] == [1]
    assert payload["gap"] == {
        "from_seq": 2,
        "to_seq_exclusive": 4,
        "seat_events": [],
        "coverage": "lost",
    }
    assert "Work governance event gap" in caplog.text


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM,
    WORK_HOST_MTLS_CLIENT_IDENTITY="work-control-plane",
    WORK_HOST_GOVERNANCE_EVENTS_IDENTITY="work-governance-events",
)
def test_governance_interior_gap_returns_the_next_extant_event(client, caplog):
    organization = factories.OrganizationFactory()
    _enable_seats(organization)
    first_membership = factories.MembershipFactory(organization=organization)
    first = work_governance.change_seat(first_membership, desired=True)
    models.WorkGovernanceSequence.objects.filter(organization=organization).update(
        last_event_seq=3
    )
    models.WorkGovernanceEvent.objects.create(
        organization=organization,
        event_seq=3,
        command_id=uuid.uuid4(),
        kind="seat",
        target_subject_id=first.target_subject_id,
        desired=False,
        payload_hash="sha256:" + "c" * 64,
        member_revision=first.member_revision + 1,
        applied_at=first.applied_at,
    )

    payload = _event_payload(client, organization)

    assert [event["event_seq"] for event in payload["events"]] == [1, 3]
    assert payload["gap"] == {
        "from_seq": 2,
        "to_seq_exclusive": 3,
        "seat_events": [],
        "coverage": "lost",
    }
    assert "from=2 to=3" in caplog.text


@override_settings(
    WORK_HOST_MTLS_CA_PEM=CA_PEM,
    WORK_HOST_MTLS_CLIENT_IDENTITY="work-control-plane",
    WORK_HOST_GOVERNANCE_EVENTS_IDENTITY="work-governance-events",
)
@pytest.mark.parametrize(
    "params",
    [
        {"after_event_seq": "-1"},
        {"after_event_seq": "1"},
        {"after_event_seq": "abc"},
        {"limit": "0"},
        {"limit": "101"},
    ],
)
def test_governance_endpoint_rejects_invalid_cursor(client, params):
    organization = factories.OrganizationFactory()
    response = client.get(
        EVENTS_URL,
        data={"org_id": str(organization.id), **params},
        **cert_headers(GOVERNANCE_CLIENT_PEM),
    )
    assert response.status_code == 422
    assert response.json() == {"code": "invalid_cursor"}


def test_governance_event_model_rejects_incomplete_seat_shape():
    organization = factories.OrganizationFactory()
    event = models.WorkGovernanceEvent(
        organization=organization,
        event_seq=1,
        command_id=uuid.uuid4(),
        kind="seat",
        target_subject_id="",
        desired=True,
        payload_hash="sha256:" + "a" * 64,
        member_revision=1,
        applied_at="2026-11-25T00:00:00Z",
    )
    with pytest.raises(DjangoValidationError):
        event.full_clean()
    with transaction.atomic():
        with pytest.raises(DatabaseError):
            event.save()
