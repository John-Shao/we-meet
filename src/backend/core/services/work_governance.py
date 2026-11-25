"""Transactional Work seat changes and their immutable governance events."""

import hashlib
import json
import re
import uuid

from django.db import transaction
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rest_framework import serializers

from core import models

SUBJECT_PATTERN = re.compile(r"^[A-Za-z0-9_.:@-]{1,128}$")
PAYLOAD_HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class GovernanceConflict(serializers.ValidationError):
    """A command id was reused with a different payload."""


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
