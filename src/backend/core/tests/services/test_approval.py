"""Tests for the P5 approval engine (services/approval.py): the serial-chain
state machine, approver resolution (manager/head/role/user + org-owner fallback),
and the best-effort SYSTEM→approver IM notification.

JusiImAdminClient is mocked so the notification path runs without a real server.
"""

# pylint: disable=redefined-outer-name,unused-argument

from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone

from core.factories import OrganizationFactory, UserFactory
from core.models import (
    ApprovalActionChoices,
    ApprovalDelegation,
    ApprovalInstance,
    ApprovalStatusChoices,
    ApprovalTaskKind,
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


# ---- delegation (P5) ----


def test_delegation_substitutes_approver(mock_im):
    org = OrganizationFactory()
    applicant, manager, deputy = UserFactory(), UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发", head=manager)
    _membership(org, applicant, department=dept)
    now = timezone.now()
    ApprovalDelegation.objects.create(
        organization=org, delegator=manager, delegate=deputy,
        start_at=now - timedelta(hours=1), end_at=now + timedelta(hours=1),
    )

    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)
    # The manager is away → the task lands on their delegate.
    assert _current_task(inst).approver_id == deputy.id
    assert inst.status == ApprovalStatusChoices.PENDING


def test_expired_or_inactive_delegation_ignored(mock_im):
    org = OrganizationFactory()
    applicant, manager, deputy = UserFactory(), UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发", head=manager)
    _membership(org, applicant, department=dept)
    now = timezone.now()
    # Window already elapsed → no substitution.
    ApprovalDelegation.objects.create(
        organization=org, delegator=manager, delegate=deputy,
        start_at=now - timedelta(days=5), end_at=now - timedelta(days=1),
    )
    # Active window but toggled off → still no substitution.
    ApprovalDelegation.objects.create(
        organization=org, delegator=manager, delegate=deputy, is_active=False,
        start_at=now - timedelta(hours=1), end_at=now + timedelta(hours=1),
    )

    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)
    assert _current_task(inst).approver_id == manager.id


# ---- urge / 催办 (P5) ----


def test_urge_notifies_current_approver_and_guards(mock_im):
    org = OrganizationFactory()
    applicant, manager = UserFactory(), UserFactory()
    dept = Department.objects.create(organization=org, name="研发", head=manager)
    _membership(org, applicant, department=dept)
    inst = approval.submit(_template(org, [{"type": "direct_manager"}]), applicant)
    before = mock_im.post_message.call_count

    # Applicant nudges → re-sends the ping, no state change.
    approval.urge(inst, applicant)
    assert mock_im.post_message.call_count == before + 1
    assert mock_im.post_message.call_args.kwargs["body"].startswith("⏰ 催办")
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.PENDING

    # Only the applicant may urge.
    with pytest.raises(exceptions.PermissionDenied):
        approval.urge(inst, manager)


# ---- 会签 / countersign (P5b) ----


def _users(user, ids):
    return [{"type": "user", "user_id": str(i)} for i in ids]


def test_countersign_and_all_must_approve(mock_im):
    org = OrganizationFactory()
    applicant, a, b = UserFactory(), UserFactory(), UserFactory()
    flow = [{"mode": "and", "approvers": _users(applicant, [a.id, b.id])}]
    inst = approval.submit(_template(org, flow), applicant)
    assert inst.tasks.filter(
        node_index=0, action=ApprovalActionChoices.PENDING
    ).count() == 2

    approval.act(inst, a, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.PENDING  # still waiting on b

    approval.act(inst, b, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.APPROVED


def test_countersign_and_any_reject_rejects(mock_im):
    org = OrganizationFactory()
    applicant, a, b = UserFactory(), UserFactory(), UserFactory()
    flow = [{"mode": "and", "approvers": _users(applicant, [a.id, b.id])}]
    inst = approval.submit(_template(org, flow), applicant)

    approval.act(inst, a, ApprovalActionChoices.REJECTED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.REJECTED


def test_countersign_or_any_one_passes(mock_im):
    org = OrganizationFactory()
    applicant, a, b = UserFactory(), UserFactory(), UserFactory()
    flow = [{"mode": "or", "approvers": _users(applicant, [a.id, b.id])}]
    inst = approval.submit(_template(org, flow), applicant)

    approval.act(inst, a, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.APPROVED
    # b's sibling task was closed → b can no longer act (instance done).
    with pytest.raises(exceptions.ValidationError):
        approval.act(inst, b, ApprovalActionChoices.APPROVED)


# ---- 条件跳过 / conditional skip (P5b) ----


def test_conditional_node_skipped_when_false(mock_im):
    org = OrganizationFactory()
    applicant, a, b = UserFactory(), UserFactory(), UserFactory()
    flow = [
        {"type": "user", "user_id": str(a.id),
         "condition": {"field": "amount", "op": ">", "value": 5000}},
        {"type": "user", "user_id": str(b.id)},
    ]
    inst = approval.submit(_template(org, flow), applicant, {"amount": "1000"})
    inst.refresh_from_db()
    assert inst.current_node == 1
    assert inst.tasks.filter(
        node_index=0, action=ApprovalActionChoices.SKIPPED
    ).exists()

    approval.act(inst, b, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.APPROVED


def test_conditional_node_kept_when_true(mock_im):
    org = OrganizationFactory()
    applicant, a, b = UserFactory(), UserFactory(), UserFactory()
    flow = [
        {"type": "user", "user_id": str(a.id),
         "condition": {"field": "amount", "op": ">", "value": 5000}},
        {"type": "user", "user_id": str(b.id)},
    ]
    inst = approval.submit(_template(org, flow), applicant, {"amount": "6000"})
    inst.refresh_from_db()
    assert inst.current_node == 0
    assert inst.tasks.filter(
        node_index=0, approver=a, action=ApprovalActionChoices.PENDING
    ).exists()


# ---- 抄送 / carbon-copy (P5b) ----


def test_cc_node_auto_passes_and_notifies(mock_im):
    org = OrganizationFactory()
    applicant, a, c = UserFactory(), UserFactory(), UserFactory()
    flow = [
        {"type": "user", "user_id": str(a.id)},
        {"type": "cc", "targets": [{"type": "user", "user_id": str(c.id)}]},
    ]
    inst = approval.submit(_template(org, flow), applicant)

    approval.act(inst, a, ApprovalActionChoices.APPROVED)
    inst.refresh_from_db()
    assert inst.status == ApprovalStatusChoices.APPROVED
    assert inst.tasks.filter(
        node_index=1, kind=ApprovalTaskKind.CC, approver=c
    ).exists()
    bodies = [call.kwargs["body"] for call in mock_im.post_message.call_args_list]
    assert any(body.startswith("📄 抄送") for body in bodies)
