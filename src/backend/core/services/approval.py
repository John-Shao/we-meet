"""Approval workflow engine (P5).

A serial single-chain state machine over ``ApprovalInstance``: submit resolves the
first node's approver and opens a task; each approve advances to the next node;
any reject ends the instance. Approver resolution walks the P1 org model
(``Department.head`` with upward fallback, ``org_role``, named user) and falls
back to the org owner so a missing department head never deadlocks a flow.

Notifications reuse the IM bridge — a SYSTEM→approver direct conversation carries
the "待你审批" nudge (and the applicant gets the final decision). Notifications are
strictly best-effort and fenced: a transport failure never breaks the state machine.

Design: docs/phases/p5-approval.md.
"""

import logging
import uuid

from django.conf import settings
from django.utils import timezone
from rest_framework import exceptions

from core.models import (
    ApprovalActionChoices,
    ApprovalInstance,
    ApprovalNodeType,
    ApprovalStatusChoices,
    ApprovalTask,
    Department,
    Membership,
    MembershipStatusChoices,
    OrgRoleChoices,
    User,
)

logger = logging.getLogger(__name__)

# jusi-light-im's reserved SYSTEM uid (see jusi 002_system_user.sql) — owner/sender
# of the approval notification DMs.
SYSTEM_UID = "00000000-0000-0000-0000-000000000000"


# ---- state machine ----------------------------------------------------------


def submit(template, applicant, form_data=None) -> ApprovalInstance:
    """Create an instance off ``template`` and open its first node.

    An empty flow auto-approves immediately. Returns the instance.
    """
    instance = ApprovalInstance.objects.create(
        organization=template.organization,
        template=template,
        applicant=applicant,
        form_data=form_data or {},
        status=ApprovalStatusChoices.PENDING,
        current_node=0,
    )
    if not (template.flow or []):
        instance.status = ApprovalStatusChoices.APPROVED
        instance.save(update_fields=["status", "updated_at"])
        _notify_applicant_decision(instance)
        return instance
    _open_node(instance, 0)
    return instance


def act(instance, actor, action, comment="") -> ApprovalInstance:
    """Record ``actor``'s decision on the current node, then advance / finish.

    Raises ValidationError (bad state / action) or PermissionDenied (not the
    current approver).
    """
    if action not in (
        ApprovalActionChoices.APPROVED,
        ApprovalActionChoices.REJECTED,
    ):
        raise exceptions.ValidationError({"action": "must be approved or rejected"})
    if instance.status != ApprovalStatusChoices.PENDING:
        raise exceptions.ValidationError({"detail": "instance is not pending"})

    task = instance.tasks.filter(node_index=instance.current_node).first()
    if task is None or task.approver_id is None or task.approver_id != actor.id:
        raise exceptions.PermissionDenied("not the current approver")
    if task.action != ApprovalActionChoices.PENDING:
        raise exceptions.ValidationError({"detail": "task already acted on"})

    task.action = action
    task.comment = comment or ""
    task.acted_at = timezone.now()
    task.save(update_fields=["action", "comment", "acted_at", "updated_at"])

    if action == ApprovalActionChoices.REJECTED:
        instance.status = ApprovalStatusChoices.REJECTED
        instance.save(update_fields=["status", "updated_at"])
        _notify_applicant_decision(instance)
        return instance

    flow = instance.template.flow or []
    if instance.current_node >= len(flow) - 1:
        instance.status = ApprovalStatusChoices.APPROVED
        instance.save(update_fields=["status", "updated_at"])
        _notify_applicant_decision(instance)
    else:
        instance.current_node += 1
        instance.save(update_fields=["current_node", "updated_at"])
        _open_node(instance, instance.current_node)
    return instance


def cancel(instance, actor) -> ApprovalInstance:
    """Applicant cancels a still-pending instance."""
    if actor.id != instance.applicant_id:
        raise exceptions.PermissionDenied("only the applicant may cancel")
    if instance.status != ApprovalStatusChoices.PENDING:
        raise exceptions.ValidationError({"detail": "instance is not pending"})
    instance.status = ApprovalStatusChoices.CANCELLED
    instance.save(update_fields=["status", "updated_at"])
    return instance


def _open_node(instance, idx) -> None:
    """Resolve node ``idx``'s approver, create its task, notify them.

    Unresolvable node → instance flips to NEEDS_ASSIGNMENT (task kept with a null
    approver) so an admin can step in; the flow does not silently auto-pass.
    """
    node = (instance.template.flow or [])[idx]
    approver = resolve_approver(instance, node)
    ApprovalTask.objects.create(
        instance=instance, node_index=idx, approver=approver
    )
    if approver is None:
        instance.status = ApprovalStatusChoices.NEEDS_ASSIGNMENT
        instance.save(update_fields=["status", "updated_at"])
        logger.warning(
            "approval %s node %s unresolved (no approver)", instance.id, idx
        )
        return
    _notify_user(approver, f"🗳️ 待你审批：{instance.template.name}")


# ---- approver resolution -----------------------------------------------------


def resolve_approver(instance, node):
    """Resolve a flow node to a User, or None if unassignable.

    direct_manager / department_head fall back to the org owner; user / org_role
    are explicit (no fallback — an unresolved one is a config error).
    """
    node = node or {}
    node_type = node.get("type")
    org = instance.organization

    if node_type == ApprovalNodeType.USER:
        return _user_by_id(node.get("user_id"))
    if node_type == ApprovalNodeType.ORG_ROLE:
        return _first_member_with_role(org, node.get("role"))
    if node_type == ApprovalNodeType.DEPARTMENT_HEAD:
        dept = _dept_by_id(node.get("department_id"))
        head = dept.head if dept else None
        return head or _org_owner(org)
    if node_type == ApprovalNodeType.DIRECT_MANAGER:
        return _direct_manager(instance.applicant, org) or _org_owner(org)
    return None


def _direct_manager(applicant, org):
    """Head of the applicant's primary department; walks up parents if the head
    is empty or is the applicant themselves. None if the chain has no other head."""
    membership = (
        applicant.memberships.filter(
            organization=org,
            status=MembershipStatusChoices.ACTIVE,
            is_primary=True,
        )
        .select_related("department")
        .first()
    )
    dept = membership.department if membership else None
    seen = set()
    while dept is not None and dept.id not in seen:
        seen.add(dept.id)
        if dept.head_id and dept.head_id != applicant.id:
            return dept.head
        dept = dept.parent
    return None


def _org_owner(org):
    membership = (
        Membership.objects.filter(
            organization=org,
            status=MembershipStatusChoices.ACTIVE,
            org_role=OrgRoleChoices.OWNER,
        )
        .select_related("user")
        .order_by("created_at")
        .first()
    )
    return membership.user if membership else None


def _first_member_with_role(org, role):
    if not role:
        return None
    membership = (
        Membership.objects.filter(
            organization=org,
            status=MembershipStatusChoices.ACTIVE,
            org_role=role,
        )
        .select_related("user")
        .order_by("created_at")
        .first()
    )
    return membership.user if membership else None


def _user_by_id(user_id):
    if not user_id:
        return None
    try:
        uuid.UUID(str(user_id))
    except (ValueError, TypeError, AttributeError):
        return None
    return User.objects.filter(id=user_id).first()


def _dept_by_id(department_id):
    if not department_id:
        return None
    try:
        uuid.UUID(str(department_id))
    except (ValueError, TypeError, AttributeError):
        return None
    return Department.objects.filter(id=department_id).first()


# ---- notifications (best-effort IM DM) ---------------------------------------


def _notify_applicant_decision(instance) -> None:
    label = {
        ApprovalStatusChoices.APPROVED: "✅ 审批已通过",
        ApprovalStatusChoices.REJECTED: "❌ 审批被拒绝",
    }.get(instance.status)
    if not label:
        return
    _notify_user(instance.applicant, f"{label}：{instance.template.name}")


def _notify_user(user, body) -> None:
    """SYSTEM→user IM direct-message. Strictly best-effort: never raises."""
    try:
        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
            return
        from core.services.im_provisioning import resolve_uid
        from core.services.jusi_im import JusiImAdminClient

        client = JusiImAdminClient(
            api_url=str(cfg["api_url"]),
            admin_hmac_secret=str(cfg["admin_hmac_secret"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )
        uid = resolve_uid(client, user)
        if not uid or uid == SYSTEM_UID:
            return
        lo, hi = sorted([SYSTEM_UID, uid])
        cid = str(uuid.uuid5(uuid.NAMESPACE_OID, f"direct:{lo}:{hi}"))
        client.create_direct(cid=cid, owner_uid=SYSTEM_UID, peer_uid=uid)
        client.post_message(cid=cid, body=body)
    except Exception:  # noqa: BLE001 — approval notification is best-effort
        logger.warning(
            "approval notify failed for user %s",
            getattr(user, "pk", None),
            exc_info=True,
        )
