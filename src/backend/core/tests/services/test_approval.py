"""Tests for the P5 approval engine (services/approval.py): the serial-chain
state machine, approver resolution (manager/head/role/user + org-owner fallback),
and the best-effort SYSTEM→approver IM notification.

JusiImAdminClient is mocked so the notification path runs without a real server.
"""

# pylint: disable=redefined-outer-name,unused-argument

from unittest import mock

import pytest

from core.factories import OrganizationFactory, UserFactory
from core.models import (
    ApprovalActionChoices,
    ApprovalInstance,
    ApprovalStatusChoices,
    ApprovalTemplate,
    Department,
    Membership,
    MembershipStatusChoices,
    OrgRoleChoices,
)
from core.services import approval
from core.services.jusi_im import (
    JusiImConversationResponse,
    JusiImMessageResponse,
    JusiImTokenResponse,
)
from rest_framework import exceptions

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_im():
    """Patch the lazily-imported JusiImAdminClient; make resolve + DM inert."""
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


def _template(org, flow):
    return ApprovalTemplate.objects.create(organization=org, name="请假", flow=flow)


def _current_task(instance):
    return instance.tasks.get(node_index=instance.current_node)


# ---- resolution + open ----


def test_submit_direct_manager_opens_task_for_head(mock_im):
    org = OrganizationFactory()
    applicant, manager = UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发", head=manager)
    _membership(org, applicant, department=dept)

    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)

    assert inst.status == ApprovalStatusChoices.PENDING
    assert _current_task(inst).approver_id == manager.id


def test_direct_manager_falls_back_to_org_owner_when_no_head(mock_im):
    org = OrganizationFactory()
    applicant, owner = UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发")  # no head
    _membership(org, applicant, department=dept)
    _membership(org, owner, org_role=OrgRoleChoices.OWNER)

    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)
    assert _current_task(inst).approver_id == owner.id


def test_resolve_department_head_org_role_and_user(mock_im):
    org = OrganizationFactory()
    applicant, head, admin, named = (UserFactory() for _ in range(4))
    dept = Department.objects.create(organization=org, name="财务", head=head)
    _membership(org, applicant)
    _membership(org, admin, org_role=OrgRoleChoices.ADMIN)

    inst = ApprovalInstance(organization=org, template=_template(org, []), applicant=applicant)
    assert approval.resolve_approver(inst, {"type": "department_head", "department_id": str(dept.id)}).id == head.id
    assert approval.resolve_approver(inst, {"type": "org_role", "role": "administrator"}).id == admin.id
    assert approval.resolve_approver(inst, {"type": "user", "user_id": str(named.id)}).id == named.id
    assert approval.resolve_approver(inst, {"type": "user", "user_id": ""}) is None


def test_unresolvable_node_marks_needs_assignment(mock_im):
    org = OrganizationFactory()
    applicant = UserFactory()
    dept = Department.objects.create(organization=org, name="孤儿部")  # no head, no org owner
    _membership(org, applicant, department=dept)

    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)
    assert inst.status == ApprovalStatusChoices.NEEDS_ASSIGNMENT
    assert _current_task(inst).approver_id is None


def test_retry_assignment_recovers_after_head_set(mock_im):
    org = OrganizationFactory()
    applicant, manager = UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="待补主管部")  # no head yet
    _membership(org, applicant, department=dept)

    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)
    assert inst.status == ApprovalStatusChoices.NEEDS_ASSIGNMENT

    # Retry while still unresolvable → stays stuck, returns False.
    assert approval.retry_assignment(inst) is False
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.NEEDS_ASSIGNMENT

    # Fix the org structure, retry → recovers to PENDING with the head assigned.
    dept.head = manager
    dept.save(update_fields=["head"])
    assert approval.retry_assignment(inst) is True
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.PENDING
    assert _current_task(inst).approver_id == manager.id

    # A recovered instance advances through the state machine normally.
    approval.act(inst, manager, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.APPROVED


# ---- state machine ----


def test_approve_single_node_marks_approved(mock_im):
    org = OrganizationFactory()
    applicant, manager = UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发", head=manager)
    _membership(org, applicant, department=dept)
    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)

    approval.act(inst, manager, ApprovalActionChoices.APPROVED, comment="ok")
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.APPROVED
    assert _current_task(inst).comment == "ok"


def test_reject_marks_rejected(mock_im):
    org = OrganizationFactory()
    applicant, manager = UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发", head=manager)
    _membership(org, applicant, department=dept)
    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)

    approval.act(inst, manager, ApprovalActionChoices.REJECTED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.REJECTED


def test_serial_chain_advances_then_approves(mock_im):
    org = OrganizationFactory()
    applicant, a, b = UserFactory(), UserFactory(), UserFactory()
    inst = approval.submit(
        _template(org, [{"type": "user", "user_id": str(a.id)}, {"type": "user", "user_id": str(b.id)}]),
        applicant,
    )
    assert inst.current_node == 0 and _current_task(inst).approver_id == a.id

    approval.act(inst, a, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.PENDING
    assert inst.current_node == 1 and _current_task(inst).approver_id == b.id

    approval.act(inst, b, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.APPROVED


def test_act_by_non_approver_denied(mock_im):
    org = OrganizationFactory()
    applicant, a, intruder = UserFactory(), UserFactory(), UserFactory()
    inst = approval.submit(_template(org, [{"type": "user", "user_id": str(a.id)}]), applicant)

    with pytest.raises(exceptions.PermissionDenied):
        approval.act(inst, intruder, ApprovalActionChoices.APPROVED)


def test_cancel_by_applicant_then_blocks_other(mock_im):
    org = OrganizationFactory()
    applicant, a, other = UserFactory(), UserFactory(), UserFactory()
    inst = approval.submit(_template(org, [{"type": "user", "user_id": str(a.id)}]), applicant)

    with pytest.raises(exceptions.PermissionDenied):
        approval.cancel(inst, other)

    approval.cancel(inst, applicant)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.CANCELLED
    # acting on a cancelled instance is rejected
    with pytest.raises(exceptions.ValidationError):
        approval.act(inst, a, ApprovalActionChoices.APPROVED)


def test_empty_flow_auto_approves(mock_im):
    org = OrganizationFactory()
    applicant = UserFactory()
    inst = approval.submit(_template(org, []), applicant)
    assert inst.status == ApprovalStatusChoices.APPROVED
    assert inst.tasks.count() == 0


# ---- notification ----


def test_opening_node_sends_system_dm(mock_im):
    org = OrganizationFactory()
    applicant, a = UserFactory(), UserFactory()
    approval.submit(_template(org, [{"type": "user", "user_id": str(a.id)}]), applicant)

    mock_im.create_direct.assert_called_once()
    mock_im.post_message.assert_called_once()
    pm = mock_im.post_message.call_args.kwargs
    assert "待你审批" in pm["body"] and pm["body"].startswith("🗳️")
    # owner of the system DM is the reserved SYSTEM uid
    assert mock_im.create_direct.call_args.kwargs["owner_uid"] == approval.SYSTEM_UID
