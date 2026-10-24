"""Two-layer tenant admission: entitlement, member grant, and claim re-checks."""

import uuid
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError

import pytest

from core.factories import MembershipFactory, OrganizationFactory, UserFactory

from work import access, local_runs, runs, services
from work.models import (
    WorkArtifactVersion,
    WorkDevice,
    WorkMaterial,
    WorkMemberGrant,
    WorkOrganizationEntitlement,
    WorkReview,
    WorkRun,
    WorkTask,
)

from .test_materials import client, upload, work_settings
from .test_runs import model_settings

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/work/"


@pytest.fixture(autouse=True)
def tenant_settings(settings, work_settings):
    settings.WORK_TENANT_ACCESS_ENABLED = True
    settings.WORK_DISABLED_ORGANIZATION_IDS = []


def grant_member(user, *, entitled=True, granted=True, features=None):
    organization = OrganizationFactory()
    MembershipFactory(user=user, organization=organization)
    if entitled:
        WorkOrganizationEntitlement.objects.create(
            organization=organization, enabled=True, features=features or {}
        )
    if granted:
        WorkMemberGrant.objects.create(
            organization=organization, user=user, enabled=True
        )
    return organization


def test_gate_off_preserves_existing_access(client, settings):
    settings.WORK_TENANT_ACCESS_ENABLED = False
    assert upload(client).status_code == 201


def test_org_without_entitlement_is_denied(client):
    grant_member(client.work_user, entitled=False)
    response = client.get(ROOT + "capabilities/")
    assert response.status_code == 403
    assert response.data == {"code": "org_disabled"}


def test_member_without_grant_is_denied(client):
    grant_member(client.work_user, granted=False)
    response = client.get(ROOT + "capabilities/")
    assert response.status_code == 403
    assert response.data == {"code": "member_disabled"}


def test_entitled_granted_member_can_use_work(client):
    grant_member(client.work_user)
    assert client.get(ROOT + "capabilities/").status_code == 200
    assert upload(client).status_code == 201


def test_disabled_or_expired_grant_is_denied(client):
    organization = grant_member(client.work_user)
    grant = WorkMemberGrant.objects.get(organization=organization)
    grant.enabled = False
    grant.save(update_fields=["enabled"])
    assert client.get(ROOT + "capabilities/").status_code == 403

    grant.enabled = True
    grant.expires_at = grant.created_at
    grant.save(update_fields=["enabled", "expires_at"])
    assert client.get(ROOT + "capabilities/").status_code == 403


def test_break_glass_blocks_entitled_org(client, settings):
    organization = grant_member(client.work_user)
    settings.WORK_DISABLED_ORGANIZATION_IDS = [str(organization.pk)]
    response = client.get(ROOT + "capabilities/")
    assert response.status_code == 403
    assert response.data == {"code": "org_disabled"}


def test_feature_override_blocks_material_but_not_capabilities(client):
    grant_member(client.work_user, features={"materials": False})
    assert client.get(ROOT + "capabilities/").status_code == 200
    response = upload(client)
    assert response.status_code == 403
    assert response.data == {"code": "feature_disabled"}


def test_multi_org_account_requires_explicit_selection(client):
    grant_member(client.work_user)
    grant_member(client.work_user)
    response = client.get(ROOT + "capabilities/")
    assert response.status_code == 409
    assert response.data == {"code": "organization_required"}


def test_header_selects_secondary_organization_for_materials(client):
    first = grant_member(client.work_user)
    second = grant_member(client.work_user)

    response = upload(client, organization_id=second.pk)
    assert response.status_code == 201
    item = WorkMaterial.objects.get(pk=response.data["id"])
    assert item.organization_id == second.pk

    listed = client.get(ROOT + "materials/", HTTP_X_ORGANIZATION_ID=str(second.pk))
    assert [row["id"] for row in listed.data["results"]] == [str(item.pk)]
    other = client.get(ROOT + "materials/", HTTP_X_ORGANIZATION_ID=str(first.pk))
    assert other.data["results"] == []


def test_header_must_be_a_uuid(client):
    grant_member(client.work_user)
    response = client.get(ROOT + "capabilities/", HTTP_X_ORGANIZATION_ID="not-a-uuid")
    assert response.status_code == 400
    assert response.data == {"code": "invalid_organization"}


def test_header_requires_active_membership(client):
    grant_member(client.work_user)
    response = client.get(
        ROOT + "capabilities/", HTTP_X_ORGANIZATION_ID=str(uuid.uuid4())
    )
    assert response.status_code == 403
    assert response.data == {"code": "member_disabled"}


def test_header_organization_entitlement_is_enforced(client):
    allowed = grant_member(client.work_user)
    blocked = grant_member(client.work_user, entitled=False)
    response = client.get(
        ROOT + "capabilities/", HTTP_X_ORGANIZATION_ID=str(blocked.pk)
    )
    assert response.status_code == 403
    assert response.data == {"code": "org_disabled"}
    assert (
        client.get(
            ROOT + "capabilities/", HTTP_X_ORGANIZATION_ID=str(allowed.pk)
        ).status_code
        == 200
    )


def test_header_scopes_task_creation(client, model_settings):
    first = grant_member(client.work_user)
    second = grant_member(client.work_user)
    uploaded = upload(client, organization_id=second.pk)
    services.process_materials()
    material = WorkMaterial.objects.get(pk=uploaded.data["id"])

    response = client.post(
        ROOT + "tasks/",
        {
            "kind": "communication",
            "recipient": "Project owner",
            "goal": "Clarify launch requirements",
            "sources": [
                {
                    "id": str(material.pk),
                    "checksum": material.checksum,
                    "parser_version": material.parser_version,
                    "generation": material.generation,
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        HTTP_X_ORGANIZATION_ID=str(second.pk),
    )
    assert response.status_code == 201, response.data
    task = WorkTask.objects.get(pk=response.data["id"])
    assert task.organization_id == second.pk

    listed = client.get(ROOT + "tasks/", HTTP_X_ORGANIZATION_ID=str(second.pk))
    assert [row["id"] for row in listed.data["results"]] == [str(task.pk)]
    other = client.get(ROOT + "tasks/", HTTP_X_ORGANIZATION_ID=str(first.pk))
    assert other.data["results"] == []


def test_header_scopes_device_registration(client, settings):
    settings.WORK_LOCAL_AGENT_ENABLED = True
    first = grant_member(client.work_user)
    second = grant_member(client.work_user)
    device_id = uuid.uuid4()
    response = client.post(
        ROOT + "local/devices/",
        {"device_id": str(device_id), "name": "Office desktop"},
        format="json",
        HTTP_X_ORGANIZATION_ID=str(second.pk),
    )
    assert response.status_code == 200, response.data
    assert WorkDevice.objects.get(pk=device_id).organization_id == second.pk

    conflict = client.post(
        ROOT + "local/devices/",
        {"device_id": str(device_id), "name": "Office desktop"},
        format="json",
        HTTP_X_ORGANIZATION_ID=str(first.pk),
    )
    assert conflict.status_code == 409
    assert conflict.data == {"code": "device_unavailable"}


def test_account_without_active_membership_is_denied(client):
    response = client.get(ROOT + "capabilities/")
    assert response.status_code == 403
    assert response.data == {"code": "member_disabled"}


def test_claim_rechecks_entitlement_before_execution(client, model_settings):
    organization = grant_member(client.work_user)
    task = WorkTask.objects.create(
        owner=client.work_user,
        organization=organization,
        request_key=uuid.uuid4(),
        kind="communication",
        recipient="Project owner",
        goal="Clarify launch requirements",
        sources=[],
    )
    run = WorkRun.objects.create(
        task=task,
        request_key=uuid.uuid4(),
        model="test-model",
        base_url="https://model.example.invalid/v1",
        reserved_tokens=100,
        max_output_tokens=10,
    )
    WorkOrganizationEntitlement.objects.filter(organization=organization).update(
        enabled=False
    )

    assert runs.claim_run() is None
    run.refresh_from_db()
    assert run.status == "access_revoked"
    assert run.error_code == "org_disabled"


def test_internal_check_is_fail_closed_on_missing_organization(client):
    assert access.check(client.work_user, None) == "organization_required"
    assert access.allows(client.work_user, uuid.uuid4()) is False


def test_access_lookup_failure_returns_503(client):
    grant_member(client.work_user)
    with patch.object(
        WorkOrganizationEntitlement.objects,
        "filter",
        side_effect=DatabaseError("database unavailable"),
    ):
        response = client.get(ROOT + "capabilities/")
    assert response.status_code == 503
    assert response.data == {"code": "access_unavailable"}


def test_scope_recheck_rejects_revoked_member(client):
    organization = grant_member(client.work_user)
    WorkMemberGrant.objects.filter(organization=organization).update(enabled=False)
    with pytest.raises(access.WorkAccessDenied) as error:
        access.require_scope(client.work_user, organization.pk)
    assert error.value.detail == {"code": "member_disabled"}
    assert error.value.status_code == 403


def test_delivery_rechecks_access_after_request_admission(client):
    organization = grant_member(client.work_user)
    task = WorkTask.objects.create(
        owner=client.work_user,
        organization=organization,
        request_key=uuid.uuid4(),
        kind="communication",
        recipient="Project owner",
        goal="Clarify launch requirements",
        sources=[],
    )
    run = WorkRun.objects.create(
        task=task,
        request_key=uuid.uuid4(),
        model="test-model",
        base_url="https://model.example.invalid/v1",
        reserved_tokens=100,
        max_output_tokens=10,
    )
    WorkArtifactVersion.objects.create(run=run, version=1, body="# Draft", citations=[])
    with patch.object(access, "check", side_effect=[None, "member_disabled"]):
        response = client.get(ROOT + f"runs/{run.pk}/files/")
    assert response.status_code == 403
    assert response.data == {"code": "member_disabled"}


def test_sources_for_rejects_revoked_organization(client):
    organization = grant_member(client.work_user)
    task = WorkTask.objects.create(
        owner=client.work_user,
        organization=organization,
        request_key=uuid.uuid4(),
        kind="communication",
        recipient="Project owner",
        goal="Clarify launch requirements",
        sources=[],
    )
    WorkOrganizationEntitlement.objects.filter(organization=organization).update(
        enabled=False
    )
    with pytest.raises(services.MaterialError) as error:
        runs.sources_for(task)
    assert (error.value.code, error.value.status) == ("org_disabled", 403)


def test_gate_requires_organization_for_new_rows(client, settings):
    settings.WORK_LOCAL_AGENT_ENABLED = True
    settings.WORK_AGENT_ROLLOUT_MODE = "all"
    user = UserFactory()
    with pytest.raises(services.MaterialError) as material:
        services.create_material(
            user, SimpleUploadedFile("notes.md", b"Background\n"), uuid.uuid4()
        )
    assert (material.value.code, material.value.status) == (
        "organization_required",
        409,
    )
    with pytest.raises(services.MaterialError) as task:
        runs.create_task(
            user,
            {"recipient": "Project owner", "goal": "Clarify", "sources": []},
            uuid.uuid4(),
        )
    assert task.value.code == "organization_required"
    with pytest.raises(services.MaterialError) as device:
        local_runs.register(user, uuid.uuid4(), "Office desktop")
    assert device.value.code == "organization_required"


def test_claim_retries_when_access_lookup_is_unavailable(client, model_settings):
    organization = grant_member(client.work_user)
    task = WorkTask.objects.create(
        owner=client.work_user,
        organization=organization,
        request_key=uuid.uuid4(),
        kind="communication",
        recipient="Project owner",
        goal="Clarify launch requirements",
        sources=[],
    )
    run = WorkRun.objects.create(
        task=task,
        request_key=uuid.uuid4(),
        model="test-model",
        base_url="https://model.example.invalid/v1",
        reserved_tokens=100,
        max_output_tokens=10,
    )
    with patch.object(
        WorkOrganizationEntitlement.objects,
        "filter",
        side_effect=DatabaseError("database unavailable"),
    ):
        assert runs.claim_run() is None
    run.refresh_from_db()
    assert run.status == "queued"


def test_daily_budget_and_reservation_are_organization_scoped(
    client, settings
):
    settings.WORK_DAILY_TOKEN_BUDGET = 100000
    first = grant_member(client.work_user)
    second = grant_member(client.work_user)
    WorkOrganizationEntitlement.objects.filter(organization=first).update(
        daily_token_budget=5000
    )
    task = WorkTask.objects.create(
        owner=client.work_user,
        organization=first,
        request_key=uuid.uuid4(),
        kind="communication",
        recipient="Project owner",
        goal="Clarify launch requirements",
        sources=[],
    )
    run = WorkRun.objects.create(
        task=task,
        request_key=uuid.uuid4(),
        model="test-model",
        base_url="https://model.example.invalid/v1",
        reserved_tokens=1200,
        max_output_tokens=10,
    )
    WorkReview.objects.create(
        source_run=run,
        request_key=uuid.uuid4(),
        selection=[],
        model="review-model",
        base_url="https://review.example.invalid/v1",
        reserved_tokens=300,
        max_output_tokens=10,
    )

    assert runs.daily_reserved(client.work_user.pk, first) == 1500
    assert runs.daily_reserved(client.work_user.pk, second) == 0
    assert runs.daily_budget(first) == 5000
    assert runs.daily_budget(second) == 100000
