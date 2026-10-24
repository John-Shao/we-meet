"""Admin entitlement and grant changes leave an attributable audit trail."""

from unittest.mock import patch

from django.contrib import admin
from django.test import RequestFactory

import pytest

from core.factories import OrganizationFactory, UserFactory

from work.admin import (
    WorkAccessAuditAdmin,
    WorkMemberGrantAdmin,
    WorkOrganizationEntitlementAdmin,
)
from work.models import WorkAccessAudit, WorkMemberGrant, WorkOrganizationEntitlement

pytestmark = pytest.mark.django_db


def request_for(user, request_id="req-123"):
    request = RequestFactory().post("/admin/", HTTP_X_REQUEST_ID=request_id)
    request.user = user
    return request


def test_entitlement_create_update_delete_are_audited():
    operator = UserFactory()
    organization = OrganizationFactory()
    model_admin = WorkOrganizationEntitlementAdmin(
        WorkOrganizationEntitlement, admin.site
    )
    entitlement = WorkOrganizationEntitlement(
        organization=organization, enabled=True, daily_token_budget=1000
    )

    model_admin.save_model(request_for(operator), entitlement, None, False)
    created = WorkAccessAudit.objects.get(action="entitlement_created")
    assert created.actor == operator
    assert created.organization == organization
    assert created.target_type == "WorkOrganizationEntitlement"
    assert created.target_id == str(entitlement.pk)
    assert created.request_id == "req-123"
    assert created.before == {}
    assert created.after["enabled"] is True
    assert created.after["daily_token_budget"] == 1000

    entitlement.enabled = False
    entitlement.disabled_reason = "pilot ended"
    model_admin.save_model(
        request_for(operator, "req-456"), entitlement, None, True
    )
    updated = WorkAccessAudit.objects.get(action="entitlement_updated")
    assert updated.before["enabled"] is True
    assert updated.after["enabled"] is False
    assert updated.after["disabled_reason"] == "pilot ended"
    assert updated.request_id == "req-456"

    target_id = str(entitlement.pk)
    model_admin.delete_model(request_for(operator, "req-789"), entitlement)
    deleted = WorkAccessAudit.objects.get(action="entitlement_deleted")
    assert deleted.target_id == target_id
    assert deleted.before["enabled"] is False
    assert deleted.after == {}
    assert deleted.request_id == "req-789"


def test_grant_changes_and_bulk_delete_are_audited():
    operator = UserFactory()
    organization = OrganizationFactory()
    user = UserFactory()
    model_admin = WorkMemberGrantAdmin(WorkMemberGrant, admin.site)
    grant = WorkMemberGrant(organization=organization, user=user, enabled=True)

    model_admin.save_model(request_for(operator), grant, None, False)
    grant.enabled = False
    model_admin.save_model(request_for(operator), grant, None, True)
    target_id = str(grant.pk)
    model_admin.delete_queryset(
        request_for(operator, "req-bulk"),
        WorkMemberGrant.objects.filter(pk=grant.pk),
    )

    created = WorkAccessAudit.objects.get(action="grant_created")
    assert created.after["user_id"] == str(user.pk)
    assert created.after["enabled"] is True
    updated = WorkAccessAudit.objects.get(action="grant_updated")
    assert updated.before["enabled"] is True
    assert updated.after["enabled"] is False
    deleted = WorkAccessAudit.objects.get(action="grant_deleted")
    assert deleted.target_id == target_id
    assert deleted.request_id == "req-bulk"
    assert deleted.before["enabled"] is False


def test_audit_failure_never_breaks_the_admin_mutation():
    operator = UserFactory()
    organization = OrganizationFactory()
    model_admin = WorkOrganizationEntitlementAdmin(
        WorkOrganizationEntitlement, admin.site
    )
    entitlement = WorkOrganizationEntitlement(organization=organization, enabled=True)

    with patch.object(
        WorkAccessAudit.objects, "create", side_effect=RuntimeError("audit down")
    ):
        model_admin.save_model(request_for(operator), entitlement, None, False)

    assert WorkOrganizationEntitlement.objects.filter(pk=entitlement.pk).exists()
    assert not WorkAccessAudit.objects.exists()


def test_audit_rows_are_read_only_in_admin():
    model_admin = WorkAccessAuditAdmin(WorkAccessAudit, admin.site)
    assert model_admin.has_add_permission(None) is False
    assert model_admin.has_change_permission(None) is False
    assert model_admin.has_delete_permission(None) is False
