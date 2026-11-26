"""Transactional Work seat changes and their immutable governance events."""

import hashlib
import json
import re
import uuid
from datetime import timezone as dt_timezone

from django.db import transaction
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rest_framework import exceptions, serializers

from core import models

SUBJECT_PATTERN = re.compile(r"^[A-Za-z0-9_.:@-]{1,128}$")
PAYLOAD_HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
WORK_GOVERNANCE_PERMISSIONS = frozenset({"org.work.seat.write"})


class GovernanceConflict(serializers.ValidationError):
    """A command id was reused with a different payload."""


class EntitlementConflict(serializers.ValidationError):
    """A Host entitlement or seat-limit precondition refused the command."""

    def __init__(self, code):
        self.code = code
        super().__init__({"code": _(code)})


def execution_entitlement_payload_hash(  # noqa: PLR0913 -- explicit signed command fields  # pylint: disable=too-many-arguments
    *,
    organization_id,
    expected_revision,
    target_revision,
    enabled,
    seat_limit,
    operator_suspended,
    operator_authorization_ref,
):
    """Return the JCS sha256 of the fields one signed entitlement command binds."""
    payload = {
        "org_id": str(organization_id),
        "expected_entitlement_revision": expected_revision,
        "target_entitlement_revision": target_revision,
        "enabled": enabled,
        "seat_limit": seat_limit,
        "operator_suspended": operator_suspended,
        "operator_authorization_ref": operator_authorization_ref,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _occupied_seats(organization_id):
    return (
        models.Membership.objects.filter(organization_id=organization_id)
        .exclude(status=models.MembershipStatusChoices.LEFT)
        .filter(work_seat=True)
        .values("user_id")
        .distinct()
        .count()
    )


def _entitlement_response(
    entitlement, *, command_id, payload_hash, status, applied_at=None
):
    response = {
        "command_id": str(command_id),
        "org_id": str(entitlement.organization_id),
        "status": status,
        "payload_hash": payload_hash,
        "enabled": entitlement.enabled,
        "seat_limit": entitlement.seat_limit,
        "operator_suspended": entitlement.operator_suspended,
        "revision": entitlement.revision,
        "occupied_seats": _occupied_seats(entitlement.organization_id),
    }
    if applied_at is not None:
        response["applied_at"] = (
            applied_at.astimezone(dt_timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )
    return response


def _is_int_at_least(value, minimum):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def apply_execution_entitlement(  # noqa: PLR0913 -- explicit operator command fields  # pylint: disable=too-many-arguments
    organization,
    *,
    command_id=None,
    expected_revision,
    target_revision,
    enabled,
    seat_limit,
    operator_suspended,
    operator_authorization_ref,
    payload_hash,
    actor=None,
):
    """Apply one operator entitlement command and append its governance event."""
    if not isinstance(enabled, bool) or not isinstance(operator_suspended, bool):
        raise serializers.ValidationError({"enabled": _("Must be a boolean.")})
    if (
        not _is_int_at_least(expected_revision, 0)
        or not _is_int_at_least(target_revision, 1)
        or not _is_int_at_least(seat_limit, 1)
    ):
        raise serializers.ValidationError(
            {"revision": _("Invalid entitlement values.")}
        )
    authorization_ref = (operator_authorization_ref or "").strip()
    if not authorization_ref or len(authorization_ref) > 200:
        raise serializers.ValidationError(
            {"operator_authorization_ref": _("An operator authorization is required.")}
        )
    command_id = command_id or uuid.uuid4()
    computed_hash = execution_entitlement_payload_hash(
        organization_id=organization.id,
        expected_revision=expected_revision,
        target_revision=target_revision,
        enabled=enabled,
        seat_limit=seat_limit,
        operator_suspended=operator_suspended,
        operator_authorization_ref=authorization_ref,
    )
    if not PAYLOAD_HASH_PATTERN.fullmatch(payload_hash or ""):
        raise serializers.ValidationError({"payload_hash": _("Invalid payload hash.")})
    if payload_hash != computed_hash:
        raise serializers.ValidationError(
            {"payload_hash": _("The payload hash does not match the command.")}
        )

    with transaction.atomic():
        organization = models.Organization.objects.select_for_update().get(
            pk=organization.pk
        )
        if not organization.is_active or organization.archived_at is not None:
            raise serializers.ValidationError({"org_id": _("Organization not found.")})
        entitlement, _created = (
            models.WorkExecutionEntitlement.objects.select_for_update().get_or_create(
                organization=organization
            )
        )
        existing = models.AuditLog.objects.filter(
            organization=organization,
            action=models.AuditActionChoices.WORK_ENTITLEMENT_APPLY,
            metadata__command_id=str(command_id),
        ).first()
        if existing is not None:
            if existing.metadata.get("payload_hash") != payload_hash:
                raise GovernanceConflict(
                    {"command_id": _("The command id was reused with another payload.")}
                )
            return {**existing.metadata["response"], "status": "replayed"}
        if expected_revision != entitlement.revision:
            raise EntitlementConflict("governance_revision_conflict")
        if target_revision <= entitlement.revision:
            raise EntitlementConflict("governance_revision_conflict")

        entitlement.enabled = enabled
        entitlement.seat_limit = seat_limit
        entitlement.operator_suspended = operator_suspended
        entitlement.revision = target_revision
        entitlement.operator_authorization_ref = authorization_ref
        entitlement.save(
            update_fields=[
                "enabled",
                "seat_limit",
                "operator_suspended",
                "revision",
                "operator_authorization_ref",
                "updated_at",
            ]
        )
        sequence, _created = (
            models.WorkGovernanceSequence.objects.select_for_update().get_or_create(
                organization=organization
            )
        )
        sequence.last_event_seq += 1
        sequence.save(update_fields=["last_event_seq"])
        applied_at = timezone.now()
        models.WorkGovernanceEvent.objects.create(
            organization=organization,
            event_seq=sequence.last_event_seq,
            command_id=command_id,
            kind=models.WorkGovernanceEventKindChoices.ENTITLEMENT,
            desired=enabled,
            payload_hash=payload_hash,
            org_revision=target_revision,
            applied_at=applied_at,
        )
        response = _entitlement_response(
            entitlement,
            command_id=command_id,
            payload_hash=payload_hash,
            status="applied",
            applied_at=applied_at,
        )
        models.AuditLog.objects.create(
            organization=organization,
            actor=actor if getattr(actor, "is_authenticated", False) else None,
            action=models.AuditActionChoices.WORK_ENTITLEMENT_APPLY,
            target_type="organization",
            target_id=str(organization.id),
            target_label=organization.name,
            metadata={
                "command_id": str(command_id),
                "payload_hash": payload_hash,
                "expected_revision": expected_revision,
                "target_revision": target_revision,
                "operator_authorization_ref": authorization_ref,
                "response": response,
            },
        )
        return response


def get_execution_entitlement_command(command_id):
    """Return the stored result of one applied entitlement command, or None."""
    audit = models.AuditLog.objects.filter(
        action=models.AuditActionChoices.WORK_ENTITLEMENT_APPLY,
        metadata__command_id=str(command_id),
    ).first()
    if audit is None:
        return None
    return {**audit.metadata["response"], "status": "applied"}


def assert_seat_change_allowed(organization, user_id):
    """Refuse a seat change the organization's entitlement or quota forbids."""
    entitlement = models.WorkExecutionEntitlement.objects.filter(
        organization=organization
    ).first()
    if entitlement is None or entitlement.revision < 1 or entitlement.seat_limit < 1:
        raise EntitlementConflict("entitlement_incomplete")
    if not entitlement.enabled or entitlement.operator_suspended:
        raise EntitlementConflict("org_execution_disabled")
    already_seated = (
        models.Membership.objects.filter(
            organization=organization,
            user_id=user_id,
            work_seat=True,
        )
        .exclude(status=models.MembershipStatusChoices.LEFT)
        .exists()
    )
    if (
        not already_seated
        and _occupied_seats(organization.id) >= entitlement.seat_limit
    ):
        raise EntitlementConflict("seat_limit_reached")


def _actor_subject(actor):
    if actor is None or not getattr(actor, "is_authenticated", False):
        return "system"
    return (getattr(actor, "sub", "") or "").strip()


def _computed_payload_hash(  # noqa: PLR0913 -- explicit command binding fields  # pylint: disable=too-many-arguments
    *,
    organization_id,
    subject_id,
    desired,
    expected_revision,
    actor_subject,
    reason_code,
):
    payload = {
        "org_id": str(organization_id),
        "target_subject_id": subject_id,
        "desired": desired,
        "expected_member_revision": expected_revision,
        "actor_subject_id": actor_subject,
        "reason_code": reason_code,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def change_seat(  # noqa: PLR0912, PLR0913 -- explicit command/CAS branches  # pylint: disable=too-many-arguments,too-many-locals,too-many-branches
    membership,
    *,
    desired,
    actor=None,
    command_id=None,
    payload_hash=None,
    expected_member_revision=None,
    reason_code="",
):
    """Apply one seat command and append its immutable governance event."""
    if not isinstance(desired, bool):
        raise serializers.ValidationError({"desired": _("Must be a boolean.")})
    command_id = command_id or uuid.uuid4()
    subject_id = (getattr(membership.user, "sub", "") or "").strip()
    if not SUBJECT_PATTERN.fullmatch(subject_id):
        raise serializers.ValidationError(
            {"target_subject_id": _("The member has no readable Work subject.")}
        )
    actor_subject = _actor_subject(actor)
    computed_hash = _computed_payload_hash(
        organization_id=membership.organization_id,
        subject_id=subject_id,
        desired=desired,
        expected_revision=expected_member_revision,
        actor_subject=actor_subject,
        reason_code=reason_code,
    )
    if payload_hash is None:
        payload_hash = computed_hash
    elif not PAYLOAD_HASH_PATTERN.fullmatch(payload_hash):
        raise serializers.ValidationError({"payload_hash": _("Invalid payload hash.")})
    elif payload_hash != computed_hash:
        raise serializers.ValidationError(
            {"payload_hash": _("The payload hash does not match the command.")}
        )

    with transaction.atomic():
        organization = models.Organization.objects.select_for_update().get(
            pk=membership.organization_id
        )
        sequence, _created = (
            models.WorkGovernanceSequence.objects.select_for_update().get_or_create(
                organization=organization
            )
        )
        existing = models.WorkGovernanceEvent.objects.filter(
            organization=organization, command_id=command_id
        ).first()
        if existing is not None:
            if existing.payload_hash != payload_hash:
                raise GovernanceConflict(
                    {"command_id": _("The command id was reused with another payload.")}
                )
            return existing

        rows = list(
            models.Membership.objects.select_for_update()
            .filter(organization=organization, user_id=membership.user_id)
            .order_by("id")
        )
        target = next((row for row in rows if row.id == membership.id), None)
        if target is None:
            raise serializers.ValidationError(
                {"detail": _("Membership no longer exists.")}
            )
        if desired and target.status != models.MembershipStatusChoices.ACTIVE:
            raise serializers.ValidationError(
                {"work_seat": _("Only an active member can receive a Work seat.")}
            )
        current_revision = max(row.directory_revision for row in rows)
        if (
            expected_member_revision is not None
            and current_revision != expected_member_revision
        ):
            raise GovernanceConflict(
                {"expected_member_revision": _("The member revision has changed.")}
            )
        if desired:
            assert_seat_change_allowed(organization, target.user_id)

        previous_seat = any(row.work_seat for row in rows)
        if desired:
            models.Membership.objects.filter(
                id__in=[row.id for row in rows],
            ).exclude(status=models.MembershipStatusChoices.LEFT).update(work_seat=True)
            models.Membership.objects.filter(
                id__in=[row.id for row in rows],
                status=models.MembershipStatusChoices.LEFT,
            ).update(work_seat=False)
        else:
            models.Membership.objects.filter(
                id__in=[row.id for row in rows],
            ).update(work_seat=False)

        for row in rows:
            row.refresh_from_db()
        member_revision = max(row.directory_revision for row in rows)
        sequence.last_event_seq += 1
        sequence.save(update_fields=["last_event_seq"])
        event = models.WorkGovernanceEvent.objects.create(
            organization=organization,
            event_seq=sequence.last_event_seq,
            command_id=command_id,
            kind=models.WorkGovernanceEventKindChoices.SEAT,
            target_subject_id=subject_id,
            desired=desired,
            payload_hash=payload_hash,
            member_revision=member_revision,
            applied_at=timezone.now(),
        )
        models.AuditLog.objects.create(
            organization=organization,
            actor=actor if getattr(actor, "is_authenticated", False) else None,
            action=models.AuditActionChoices.MEMBER_UPDATE,
            target_type="membership",
            target_id=target.id,
            target_label=target.user.full_name or target.user.email or "",
            metadata={
                "work_seat": {"from": previous_seat, "to": desired},
                "command_id": str(command_id),
                "event_seq": event.event_seq,
                "member_revision": member_revision,
                "payload_hash": payload_hash,
                "reason_code": reason_code,
            },
        )
        return event


def revoke_seat_without_subject(membership, *, actor=None, reason_code=""):
    """Clear an anonymized member's seat without inventing a Work subject."""
    with transaction.atomic():
        organization = models.Organization.objects.select_for_update().get(
            pk=membership.organization_id
        )
        rows = list(
            models.Membership.objects.select_for_update()
            .filter(organization=organization, user_id=membership.user_id)
            .order_by("id")
        )
        target = next((row for row in rows if row.id == membership.id), None)
        if target is None:
            raise serializers.ValidationError(
                {"detail": _("Membership no longer exists.")}
            )
        previous_seat = any(row.work_seat for row in rows)
        models.Membership.objects.filter(id__in=[row.id for row in rows]).update(
            work_seat=False
        )
        models.AuditLog.objects.create(
            organization=organization,
            actor=actor if getattr(actor, "is_authenticated", False) else None,
            action=models.AuditActionChoices.MEMBER_UPDATE,
            target_type="membership",
            target_id=target.id,
            target_label=target.user.full_name or target.user.email or "",
            metadata={
                "work_seat": {"from": previous_seat, "to": False},
                "governance_event": "not_emitted",
                "reason_code": reason_code,
                "reason": "subject_unreadable",
            },
        )


def validate_work_governance_permissions(codes):
    """Return the sorted closed permission set, refusing unknown codes."""
    cleaned = {str(code).strip() for code in codes or [] if str(code).strip()}
    unknown = sorted(cleaned - WORK_GOVERNANCE_PERMISSIONS)
    if unknown:
        raise serializers.ValidationError(
            {
                "permissions": _("Unknown Work governance permission: %(codes)s")
                % {"codes": ", ".join(unknown)}
            }
        )
    return sorted(cleaned)


def work_permissions_for_user(user, organization):
    """Return the active Work governance permissions for one user in one organization."""
    if (
        user is None
        or not getattr(user, "is_active", False)
        or organization is None
        or not organization.is_active
        or organization.archived_at is not None
    ):
        return []
    if not models.Membership.objects.filter(
        organization=organization,
        user=user,
        status=models.MembershipStatusChoices.ACTIVE,
    ).exists():
        return []
    permissions = set()
    rows = models.WorkGovernanceAssignment.objects.filter(
        organization=organization,
        user=user,
        status=models.WorkGovernanceAssignmentStatusChoices.ACTIVE,
    ).values_list("permissions", flat=True)
    for codes in rows:
        permissions.update(set(codes or []) & WORK_GOVERNANCE_PERMISSIONS)
    return sorted(permissions)


def change_work_governance_assignment(  # noqa: PLR0913 -- explicit assignment command fields  # pylint: disable=too-many-arguments
    organization,
    target_user,
    *,
    permissions,
    actor,
    expected_revision=None,
    client_request_id="",
):
    """Replace one user's Work governance assignment under its CAS revision."""
    permissions = validate_work_governance_permissions(permissions)
    if not getattr(actor, "is_authenticated", False):
        raise exceptions.PermissionDenied()

    with transaction.atomic():
        organization = models.Organization.objects.select_for_update().get(
            pk=organization.pk
        )
        if not organization.is_active or organization.archived_at is not None:
            raise exceptions.PermissionDenied()
        if not models.Membership.objects.filter(
            organization=organization,
            user=actor,
            status=models.MembershipStatusChoices.ACTIVE,
            org_role=models.OrgRoleChoices.OWNER,
        ).exists():
            raise exceptions.PermissionDenied()
        if (
            not getattr(target_user, "is_active", False)
            or not models.Membership.objects.filter(
                organization=organization,
                user=target_user,
                status=models.MembershipStatusChoices.ACTIVE,
            ).exists()
        ):
            raise serializers.ValidationError(
                {"user_id": _("Target must be an active member of this organization.")}
            )
        subject_id = (getattr(target_user, "sub", "") or "").strip()
        if not SUBJECT_PATTERN.fullmatch(subject_id):
            raise serializers.ValidationError(
                {"user_id": _("Target has no readable Work subject.")}
            )
        payload = {
            "org_id": str(organization.id),
            "target_subject_id": subject_id,
            "permissions": permissions,
            "expected_revision": expected_revision,
            "actor_subject_id": _actor_subject(actor),
            "client_request_id": client_request_id,
        }
        payload_hash = (
            "sha256:"
            + hashlib.sha256(
                json.dumps(
                    payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
        )
        assignment = (
            models.WorkGovernanceAssignment.objects.select_for_update()
            .filter(organization=organization, user=target_user)
            .first()
        )
        if assignment is None:
            if expected_revision not in (None, 0):
                raise GovernanceConflict(
                    {"expected_revision": _("Assignment does not exist.")}
                )
            assignment = models.WorkGovernanceAssignment(
                organization=organization,
                user=target_user,
                revision=0,
            )
        elif expected_revision != assignment.revision:
            raise GovernanceConflict(
                {"expected_revision": _("The assignment revision has changed.")}
            )
        assignment.permissions = permissions
        assignment.revision += 1
        assignment.status = (
            models.WorkGovernanceAssignmentStatusChoices.ACTIVE
            if permissions
            else models.WorkGovernanceAssignmentStatusChoices.REVOKED
        )
        assignment.granted_by = actor
        assignment.save()

        sequence, _created = (
            models.WorkGovernanceSequence.objects.select_for_update().get_or_create(
                organization=organization
            )
        )
        sequence.last_event_seq += 1
        sequence.save(update_fields=["last_event_seq"])
        event = models.WorkGovernanceEvent.objects.create(
            organization=organization,
            event_seq=sequence.last_event_seq,
            command_id=uuid.uuid4(),
            kind=models.WorkGovernanceEventKindChoices.ASSIGNMENT,
            target_subject_id=subject_id,
            desired=bool(permissions),
            payload_hash=payload_hash,
            permissions_revision=assignment.revision,
            applied_at=timezone.now(),
        )
        action = (
            models.AuditActionChoices.WORK_GOVERNANCE_GRANT
            if permissions
            else models.AuditActionChoices.WORK_GOVERNANCE_REVOKE
        )
        models.AuditLog.objects.create(
            organization=organization,
            actor=actor,
            action=action,
            target_type="work_governance_assignment",
            target_id=assignment.id,
            target_label=target_user.full_name or target_user.email or "",
            metadata={
                "permissions": permissions,
                "revision": assignment.revision,
                "event_seq": event.event_seq,
                "command_id": str(event.command_id),
                "payload_hash": payload_hash,
                "client_request_id": client_request_id,
            },
        )
        return assignment, event
