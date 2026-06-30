"""API tests for P5 approvals: submit, list (mine / pending-on-me), act, cancel,
and the authorization boundaries. JusiImAdminClient is mocked (submit triggers the
notification path)."""

# pylint: disable=redefined-outer-name,unused-argument

from unittest import mock

import pytest
from rest_framework.test import APIClient

from core.factories import OrganizationFactory, UserFactory
from core.models import (
    ApprovalStatusChoices,
    ApprovalTemplate,
    Department,
    Membership,
    MembershipStatusChoices,
    OrgRoleChoices,
)
from core.services.jusi_im import (
    JusiImConversationResponse,
    JusiImMessageResponse,
    JusiImTokenResponse,
)

pytestmark = pytest.mark.django_db

BASE = "/api/v1.0/approvals/"


@pytest.fixture(autouse=True)
def mock_im():
    """Mute the notification IM path for all API tests."""
    with mock.patch("core.services.jusi_im.JusiImAdminClient") as ctor:
        instance = mock.Mock()
        ctor.return_value = instance
        instance.issue_token.side_effect = lambda external_id, ttl_seconds: (
            JusiImTokenResponse(uid=f"imuid-{external_id}", token="t", expires_at=0)
        )
        instance.create_direct.return_value = JusiImConversationResponse(
            cid="x", type="direct", owner_uid="x", members=[], created_at=0
        )
        instance.post_message.return_value = JusiImMessageResponse(
            mid=1, cid="x", sender_uid="sys", seq=1, ts=0
        )
        yield instance


def _membership(org, user, department=None, org_role=OrgRoleChoices.MEMBER):
    return Membership.objects.create(
        organization=org,
        user=user,
        department=department,
        is_primary=True,
        status=MembershipStatusChoices.ACTIVE,
        org_role=org_role,
    )


def _setup():
    """org + applicant + manager (dept head) + a direct_manager template."""
    org = OrganizationFactory()
    applicant, manager = UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发", head=manager)
    _membership(org, applicant, department=dept)
    _membership(org, manager, department=dept)
    template = ApprovalTemplate.objects.create(
        organization=org, name="请假", flow=[{"type": "direct_manager"}]
    )
    return org, applicant, manager, template


def _submit(applicant, template, form_data=None):
    client = APIClient()
    client.force_login(applicant)
    return client.post(
        BASE, {"template": str(template.id), "form_data": form_data or {}}, format="json"
    )


# ---- auth ----


def test_requires_authentication():
    assert APIClient().get(BASE).status_code == 401


# ---- submit ----


def test_submit_opens_first_task(mock_im):
    _, applicant, manager, template = _setup()
    resp = _submit(applicant, template, {"reason": "事假一天"})

    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["status"] == ApprovalStatusChoices.PENDING
    assert body["applicant"]["id"] == str(applicant.id)
    assert body["tasks"][0]["approver"]["id"] == str(manager.id)


# ---- listing ----


def test_pending_list_shows_to_approver(mock_im):
    _, applicant, manager, template = _setup()
    _submit(applicant, template)

    client = APIClient()
    client.force_login(manager)
    resp = client.get(BASE, {"role": "pending"})
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 1


def test_mine_list_shows_to_applicant(mock_im):
    _, applicant, manager, template = _setup()
    _submit(applicant, template)

    client = APIClient()
    client.force_login(applicant)
    resp = client.get(BASE, {"role": "mine"})
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 1
    # manager's own "mine" list is empty (they didn't submit anything)
    mclient = APIClient()
    mclient.force_login(manager)
    assert len(mclient.get(BASE, {"role": "mine"}).json()["results"]) == 0


# ---- act / cancel ----


def test_act_approve_finishes(mock_im):
    _, applicant, manager, template = _setup()
    instance_id = _submit(applicant, template).json()["id"]

    client = APIClient()
    client.force_login(manager)
    resp = client.post(f"{BASE}{instance_id}/act/", {"action": "approved"}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == ApprovalStatusChoices.APPROVED


def test_act_by_applicant_not_approver_403(mock_im):
    _, applicant, manager, template = _setup()
    instance_id = _submit(applicant, template).json()["id"]

    client = APIClient()
    client.force_login(applicant)  # applicant is involved but NOT the current approver
    resp = client.post(f"{BASE}{instance_id}/act/", {"action": "approved"}, format="json")
    assert resp.status_code == 403


def test_act_by_uninvolved_404(mock_im):
    _, applicant, manager, template = _setup()
    org = applicant.memberships.first().organization
    intruder = UserFactory()
    _membership(org, intruder)
    instance_id = _submit(applicant, template).json()["id"]

    client = APIClient()
    client.force_login(intruder)  # not applicant, not approver → not in queryset
    resp = client.post(f"{BASE}{instance_id}/act/", {"action": "approved"}, format="json")
    assert resp.status_code == 404


def test_cancel_by_applicant(mock_im):
    _, applicant, manager, template = _setup()
    instance_id = _submit(applicant, template).json()["id"]

    client = APIClient()
    client.force_login(applicant)
    resp = client.post(f"{BASE}{instance_id}/cancel/", {}, format="json")
    assert resp.status_code == 200
    assert resp.json()["status"] == ApprovalStatusChoices.CANCELLED
