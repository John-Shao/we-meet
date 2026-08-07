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
from django.db import transaction
from django.utils import timezone
from rest_framework import exceptions

from core.models import (
    ApprovalActionChoices,
    ApprovalDelegation,
    ApprovalInstance,
    ApprovalNodeType,
    ApprovalStatusChoices,
    ApprovalTask,
    ApprovalTaskKind,
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
    """Create an instance off ``template`` and open from its first node.

    An empty flow (or one that only skips / CCs) auto-approves. Returns the instance.
    """
    instance = ApprovalInstance.objects.create(
        organization=template.organization,
        template=template,
        applicant=applicant,
        form_data=form_data or {},
        status=ApprovalStatusChoices.PENDING,
        current_node=0,
    )
    _open_from(instance, 0)
    return instance


def act(instance, actor, action, comment="") -> ApprovalInstance:
    """Record ``actor``'s decision on their task at the current node, then evaluate
    the node (会签 aggregation) and advance / finish.

    - any REJECTED on the node → instance rejected (both and & or modes).
    - or-mode: one APPROVED passes the node (remaining pending siblings closed).
    - and/single-mode: the node passes once every approver has approved.

    Raises ValidationError (bad state / action) or PermissionDenied (not a current
    approver). Wrapped in a row-locked transaction so concurrent acts on an
    or-node can't double-advance.
    """
    if action not in (
        ApprovalActionChoices.APPROVED,
        ApprovalActionChoices.REJECTED,
    ):
        raise exceptions.ValidationError({"action": "must be approved or rejected"})

    with transaction.atomic():
        # Lock the instance so a parallel act sees our status/task change.
        instance = ApprovalInstance.objects.select_for_update().get(pk=instance.pk)
        if instance.status != ApprovalStatusChoices.PENDING:
            raise exceptions.ValidationError({"detail": "instance is not pending"})

        idx = instance.current_node
        task = instance.tasks.filter(
            node_index=idx,
            approver_id=actor.id,
            kind=ApprovalTaskKind.APPROVE,
        ).first()
        if task is None:
            raise exceptions.PermissionDenied("not a current approver")
        if task.action != ApprovalActionChoices.PENDING:
            raise exceptions.ValidationError({"detail": "task already acted on"})

        task.action = action
        task.comment = comment or ""
        task.acted_at = timezone.now()
        task.save(update_fields=["action", "comment", "acted_at", "updated_at"])

        # Aggregate the node's real approver tasks (exclude cc / null placeholders).
        node = (instance.template.flow or [])[idx]
        mode = (node or {}).get("mode", "single")
        siblings = list(
            instance.tasks.filter(
                node_index=idx,
                kind=ApprovalTaskKind.APPROVE,
                approver__isnull=False,
            )
        )
        if any(t.action == ApprovalActionChoices.REJECTED for t in siblings):
            instance.status = ApprovalStatusChoices.REJECTED
            instance.save(update_fields=["status", "updated_at"])
            _notify_applicant_decision(instance)
            return instance

        approved = [t for t in siblings if t.action == ApprovalActionChoices.APPROVED]
        if mode == "or":
            node_done = len(approved) >= 1
            if node_done:
                # One approval carries the node — close the other pending siblings.
                for t in siblings:
                    if t.action == ApprovalActionChoices.PENDING:
                        t.action = ApprovalActionChoices.SKIPPED
                        t.acted_at = timezone.now()
                        t.save(update_fields=["action", "acted_at", "updated_at"])
        else:  # and / single
            node_done = len(approved) == len(siblings)

        if node_done:
            _open_from(instance, idx + 1)
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


def urge(instance, actor) -> ApprovalInstance:
    """Applicant nudges the current approver (催办). Re-sends the pending-approval
    IM notification; no state change. Only the applicant of a still-pending
    instance may urge."""
    if actor.id != instance.applicant_id:
        raise exceptions.PermissionDenied("only the applicant may urge")
    if instance.status != ApprovalStatusChoices.PENDING:
        raise exceptions.ValidationError({"detail": "instance is not pending"})
    pending = instance.tasks.filter(
        node_index=instance.current_node,
        kind=ApprovalTaskKind.APPROVE,
        action=ApprovalActionChoices.PENDING,
        approver__isnull=False,
    ).select_related("approver")
    approvers = [t.approver for t in pending]
    if not approvers:
        raise exceptions.ValidationError({"detail": "no current approver to urge"})
    for approver in approvers:
        _notify_user(approver, f"⏰ 催办:{instance.template.name} 待你审批")
    return instance


def retry_assignment(instance) -> bool:
    """Re-resolve the current node's approver for a NEEDS_ASSIGNMENT instance.

    The recovery path out of NEEDS_ASSIGNMENT (which otherwise deadlocks): after
    the org structure / template is fixed — e.g. a department head is finally set,
    or a user is given the required org_role — an admin retries. On success the
    existing null-approver task is assigned, the instance flips back to PENDING and
    the approver is notified; returns True. Still unresolvable → stays put, returns
    False. No-op (False) if the instance isn't in NEEDS_ASSIGNMENT.
    """
    if instance.status != ApprovalStatusChoices.NEEDS_ASSIGNMENT:
        return False
    flow = instance.template.flow or []
    idx = instance.current_node
    node = flow[idx] if 0 <= idx < len(flow) else None
    approvers = resolve_all(instance, node) if node is not None else []
    if not approvers:
        return False
    # Drop the null-approver placeholder left by _open_from, then open the node
    # for real (会签 → one task per approver).
    instance.tasks.filter(node_index=idx, approver__isnull=True).delete()
    for approver in approvers:
        ApprovalTask.objects.create(
            instance=instance, node_index=idx, approver=approver,
            kind=ApprovalTaskKind.APPROVE,
        )
    instance.status = ApprovalStatusChoices.PENDING
    instance.save(update_fields=["status", "updated_at"])
    for approver in approvers:
        _notify_user(approver, f"🗳️ 待你审批：{instance.template.name}")
    return True


def _open_from(instance, idx) -> None:
    """Advance the flow from node ``idx``, auto-passing 抄送 (cc) and condition-
    skipped nodes, until a node that needs an approver — then create its tasks and
    stop. Running off the end approves the instance.

    Unresolvable approver node → NEEDS_ASSIGNMENT (a null-approver placeholder kept
    at that node) so an admin can retry; the flow never silently auto-passes it.
    """
    flow = instance.template.flow or []
    while idx < len(flow):
        node = flow[idx] or {}

        # 抄送:notify + auto-advance (never blocks).
        if node.get("type") == ApprovalNodeType.CC:
            _record_cc(instance, idx, node)
            idx += 1
            continue

        # 条件跳过:condition present + false → skip this node.
        if not _condition_holds(node, instance.form_data):
            ApprovalTask.objects.create(
                instance=instance, node_index=idx, approver=None,
                kind=ApprovalTaskKind.APPROVE, action=ApprovalActionChoices.SKIPPED,
            )
            idx += 1
            continue

        approvers = resolve_all(instance, node)
        if not approvers:
            instance.current_node = idx
            instance.status = ApprovalStatusChoices.NEEDS_ASSIGNMENT
            instance.save(update_fields=["current_node", "status", "updated_at"])
            ApprovalTask.objects.create(
                instance=instance, node_index=idx, approver=None,
                kind=ApprovalTaskKind.APPROVE,
            )
            logger.warning(
                "approval %s node %s unresolved (no approver)", instance.id, idx
            )
            return

        instance.current_node = idx
        instance.save(update_fields=["current_node", "updated_at"])
        for approver in approvers:
            ApprovalTask.objects.create(
                instance=instance, node_index=idx, approver=approver,
                kind=ApprovalTaskKind.APPROVE,
            )
        for approver in approvers:
            _notify_user(approver, f"🗳️ 待你审批：{instance.template.name}")
        return

    # Flow exhausted → approved.
    instance.status = ApprovalStatusChoices.APPROVED
    instance.save(update_fields=["status", "updated_at"])
    _notify_applicant_decision(instance)


def _record_cc(instance, idx, node) -> None:
    """抄送 node: one cc task per resolved target + an FYI IM ping, then auto-pass."""
    targets = []
    seen = set()
    for sub in node.get("targets") or []:
        user = resolve_approver(instance, sub)
        if user and user.id not in seen:
            seen.add(user.id)
            targets.append(user)
    for user in targets:
        ApprovalTask.objects.create(
            instance=instance, node_index=idx, approver=user,
            kind=ApprovalTaskKind.CC, action=ApprovalActionChoices.NOTIFIED,
        )
    for user in targets:
        _notify_user(user, f"📄 抄送:{instance.template.name}")


# ---- approver resolution -----------------------------------------------------


def resolve_approver(instance, node):
    """Resolve a flow node to a User, or None if unassignable.

    direct_manager / department_head fall back to the org owner; user / org_role
    are explicit (no fallback — an unresolved one is a config error). A resolved
    approver is then run through any active delegation (P5) so the task lands on
    the stand-in during the delegator's absence.
    """
    node = node or {}
    node_type = node.get("type")
    org = instance.organization

    if node_type == ApprovalNodeType.USER:
        base = _user_by_id(node.get("user_id"))
    elif node_type == ApprovalNodeType.ORG_ROLE:
        base = _first_member_with_role(org, node.get("role"))
    elif node_type == ApprovalNodeType.DEPARTMENT_HEAD:
        dept = _dept_by_id(node.get("department_id"))
        head = dept.head if dept else None
        base = head or _org_owner(org)
    elif node_type == ApprovalNodeType.DIRECT_MANAGER:
        base = _direct_manager(instance.applicant, org) or _org_owner(org)
    else:
        base = None
    return _apply_delegation(base, org)


def _apply_delegation(approver, org):
    """If ``approver`` has an active delegation in ``org`` right now, return the
    delegate instead — one hop only (delegations never chain, so no loops)."""
    if approver is None:
        return None
    now = timezone.now()
    delegation = (
        ApprovalDelegation.objects.filter(
            organization=org,
            delegator=approver,
            is_active=True,
            start_at__lte=now,
            end_at__gte=now,
        )
        .select_related("delegate")
        .order_by("-start_at")
        .first()
    )
    if delegation and delegation.delegate_id != approver.id:
        return delegation.delegate
    return approver


def resolve_all(instance, node):
    """Resolve a node to a de-duplicated list of approver Users (会签).

    ``node.approvers`` (a list of sub-rules) → one User each; otherwise the node's
    own single rule → a 1-element list. Each resolved user passes through delegation
    (via resolve_approver). Empty list = unresolvable.
    """
    node = node or {}
    specs = node.get("approvers")
    if not specs:
        one = resolve_approver(instance, node)
        return [one] if one else []
    users = []
    seen = set()
    for sub in specs:
        user = resolve_approver(instance, sub)
        if user and user.id not in seen:
            seen.add(user.id)
            users.append(user)
    return users


def _condition_holds(node, form_data) -> bool:
    """True if the node has no condition, or its condition holds against form_data.

    condition = {"field", "op", "value"}; op ∈ == != > >= < <= in. A missing field
    or type mismatch evaluates False (→ skip the node), never raises.
    """
    cond = (node or {}).get("condition")
    if not cond:
        return True
    actual = (form_data or {}).get(cond.get("field"))
    return _cmp(actual, cond.get("op"), cond.get("value"))


def _cmp(actual, op, expected) -> bool:
    try:
        if op == "==":
            return actual == expected
        if op == "!=":
            return actual != expected
        if op == "in":
            return actual in (expected or [])
        # Ordering comparisons coerce to float so "5000" (form text) works.
        a, b = float(actual), float(expected)
        if op == ">":
            return a > b
        if op == ">=":
            return a >= b
        if op == "<":
            return a < b
        if op == "<=":
            return a <= b
    except (TypeError, ValueError):
        return False
    return False


def _direct_manager(applicant, org):
    """The applicant's approver: explicit reporting line first, department head after.

    An explicit ``Membership.manager`` wins when one is set — walking the
    department tree gets the wrong person in matrix orgs and anywhere someone
    reports across departments. When it is unset (the common case until an org
    fills the field in), the behaviour is byte-for-byte the previous one: head
    of the primary department, walking up parents past empty heads and past the
    applicant themselves.

    The dotted line is deliberately ignored — it exists for org charts, not for
    routing approvals.
    """
    membership = (
        applicant.memberships.filter(
            organization=org,
            status=MembershipStatusChoices.ACTIVE,
            is_primary=True,
        )
        .select_related("department", "manager__user")
        .first()
    )
    if membership is None:
        return None

    manager = membership.manager
    if (
        manager is not None
        and manager.status == MembershipStatusChoices.ACTIVE
        and manager.user_id != applicant.id
    ):
        return manager.user

    dept = membership.department
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
    """Assistant→user IM direct-message. Strictly best-effort: never raises.

    Sent as 审批助手 when that assistant is seeded, otherwise as SYSTEM. The
    difference is visible: a bot sender gives the conversation an avatar, a name
    and a description instead of an anonymous all-zero uid.

    ⚠️ The cid is derived from the two participants, so switching the sender
    **changes it** — an existing SYSTEM conversation stays as read-only history
    and a new 审批助手 conversation appears alongside it. That is the intended
    end state (one assistant, one conversation, as in 飞书); adding the bot to
    the old direct conversation instead would give it three members, which the
    clients' "render the *other* member" logic cannot express.
    """
    try:
        cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
        if not cfg or not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
            return
        from core.services import im_bots
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

        assistant = im_bots.get_builtin(im_bots.BOT_APPROVAL_ASSISTANT)
        sender_uid = SYSTEM_UID
        if assistant is not None:
            sender_uid = im_bots.resolve_bot_uid(client, assistant) or SYSTEM_UID
        if sender_uid == uid:
            # Would make a direct conversation with itself; fall back.
            sender_uid = SYSTEM_UID

        lo, hi = sorted([sender_uid, uid])
        cid = str(uuid.uuid5(uuid.NAMESPACE_OID, f"direct:{lo}:{hi}"))
        client.create_direct(cid=cid, owner_uid=sender_uid, peer_uid=uid)
        if sender_uid == SYSTEM_UID:
            client.post_message(cid=cid, body=body)
        else:
            # **这是全仓唯一不记安装的 post_as。** 这是一对一私信,而 M 端治理页
            # 叫「群机器人」—— 一个人和助手的私聊不该进运营视野,而且那是
            # (助手 × 每个人)的笛卡尔积,会把几十个真正要治理的自定义机器人冲没。
            im_bots.post_as(client, assistant, cid, body, record_installation=False)
    except Exception:  # noqa: BLE001 — approval notification is best-effort
        logger.warning(
            "approval notify failed for user %s",
            getattr(user, "pk", None),
            exc_info=True,
        )
