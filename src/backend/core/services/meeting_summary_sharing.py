"""Explicit summary-only grants with fresh previews and non-reapplying retry receipts."""

import uuid

from django.conf import settings
from django.db import transaction
from django.db.models import Q

from core import models
from core.services.meeting_records import RecordConflict, visible_records
from core.services.meeting_summary_exports import can_export, digest

MAX_RECIPIENTS = 50


def enabled():
    return settings.MEETING_RECORDS_ENABLED and settings.MEETING_SUMMARY_SHARING_ENABLED


def can_manage(record, user):
    return can_export(record, user)


def eligible_users(record, actor):
    """Organization directory or known participants, never a global user search."""
    memberships = models.Membership.objects.filter(
        status=models.MembershipStatusChoices.ACTIVE, organization__is_active=True
    )
    if record.organization_id:
        return models.User.objects.filter(
            is_active=True,
            pk__in=memberships.filter(organization_id=record.organization_id).values(
                "user_id"
            ),
        )
    common = memberships.filter(
        organization_id__in=memberships.filter(user=actor).values("organization_id")
    ).values("user_id")
    known = Q(pk__in=common) | Q(pk=actor.pk)
    if record.meeting_session_id:
        known |= Q(
            pk__in=models.MeetingParticipation.objects.filter(
                session_id=record.meeting_session_id, user__isnull=False
            ).values("user_id")
        ) | Q(
            pk__in=models.ResourceAccess.objects.filter(
                resource_id=record.meeting_session.room_id
            ).values("user_id")
        )
    return models.User.objects.filter(known, is_active=True)


def _targets(user_ids):
    ids = sorted({str(uuid.UUID(str(value))) for value in user_ids})
    if not ids or len(ids) > MAX_RECIPIENTS or len(ids) != len(user_ids):
        raise RecordConflict("Select distinct recipients within the batch limit.")
    users = list(models.User.objects.filter(pk__in=ids).order_by("pk"))
    if len(users) != len(ids):
        raise RecordConflict("Recipient selection changed.")
    return users


def preview(record, actor, user_ids, operation):
    if not can_manage(record, actor):
        raise PermissionError
    if operation not in {"grant", "revoke"}:
        raise RecordConflict("Unsupported sharing operation.")
    users = _targets(user_ids)
    eligible = set(
        eligible_users(record, actor)
        .filter(pk__in=user_ids)
        .values_list("pk", flat=True)
    )
    grants = {row.user_id: row for row in record.accesses.filter(user__in=users)}
    if operation == "grant" and any(user.pk not in eligible for user in users):
        raise RecordConflict("Recipient selection changed.")
    if operation == "revoke" and any(user.pk not in grants for user in users):
        raise RecordConflict("Explicit share no longer exists.")
    inherited = set()
    if record.meeting_session_id:
        inherited = set(
            models.ResourceAccess.objects.filter(
                resource_id=record.meeting_session.room_id, user__in=users
            ).values_list("user_id", flat=True)
        )
    elif record.owner_id:
        inherited.add(record.owner_id)
    recipients = []
    for user in users:
        grant = grants.get(user.pk)
        scoped = visible_records(user).filter(pk=record.pk).first()
        recipients.append(
            {
                "id": str(user.pk),
                "name": user.full_name or "",
                "active": user.is_active,
                "explicit_summary": bool(grant and grant.read_summary),
                "explicit_transcript": bool(grant and grant.read_transcript),
                "effective_summary": bool(scoped and scoped.can_read_summary),
                "effective_transcript": bool(scoped and scoped.can_read_transcript),
                "inherited_summary": bool(scoped and user.pk in inherited),
                "after_explicit_summary": operation == "grant",
                "after_effective_summary": operation == "grant"
                or bool(scoped and user.pk in inherited),
                "grant_id": str(grant.pk) if grant else None,
                "grant_updated_at": grant.updated_at.isoformat() if grant else None,
            }
        )
    result = {
        "record_id": str(record.pk),
        "title": record.title,
        "organization_id": str(record.organization_id)
        if record.organization_id
        else None,
        "operation": operation,
        "scope": "all_record_summary_versions",
        "recipients": recipients,
        "grants_originals": False,
        "grants_media": False,
        "changes_document_permissions": False,
        "sends_messages": False,
    }
    return {**result, "preview_hash": digest(result)}


@transaction.atomic
def apply_share(record_id, actor, key, user_ids, operation, expected_hash):  # noqa: PLR0913 -- explicit preview contract
    # Consistent user ordering also covers two managers sharing with one another.
    target_ids = {str(uuid.UUID(str(value))) for value in user_ids}
    list(
        models.User.objects.select_for_update()
        .filter(pk__in=target_ids | {str(actor.pk)})
        .order_by("pk")
    )
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not can_manage(record, actor):
        raise PermissionError
    request_hash = digest(
        [str(record_id), sorted(target_ids), operation, expected_hash]
    )
    previous = models.MeetingSummaryShareRequest.objects.filter(
        user=actor, key=key
    ).first()
    if previous:
        if previous.request_hash != request_hash:
            raise RecordConflict("Sharing request key conflicts.")
        # Return the receipt, never reapply a grant since revoked by another action.
        return previous, True
    if not enabled():
        raise PermissionError
    # Serialize against existing role/membership revocations before the final check.
    list(
        models.Membership.objects.select_for_update()
        .filter(user_id__in=target_ids | {str(actor.pk)})
        .order_by("pk")
    )
    if record.meeting_session_id:
        list(
            models.ResourceAccess.objects.select_for_update()
            .filter(resource_id=record.meeting_session.room_id)
            .order_by("pk")
        )
    list(
        record.accesses.select_for_update()
        .filter(user_id__in=target_ids)
        .order_by("pk")
    )
    current = preview(record, actor, user_ids, operation)
    if current["preview_hash"] != expected_hash:
        raise RecordConflict("Sharing preview changed.")
    for user_id in target_ids:
        if operation == "grant":
            row, _ = models.MeetingRecordAccess.objects.get_or_create(
                record=record, user_id=user_id
            )
            if not row.read_summary:
                row.read_summary = True
                row.save(update_fields=["read_summary", "updated_at"])
        else:
            row = record.accesses.get(user_id=user_id)
            if row.read_transcript:
                row.read_summary = False
                row.save(update_fields=["read_summary", "updated_at"])
            else:
                row.delete()
    receipt = models.MeetingSummaryShareRequest.objects.create(
        user=actor, record=record, key=key, request_hash=request_hash, preview=current
    )
    return receipt, False
