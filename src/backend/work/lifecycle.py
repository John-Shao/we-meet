"""Close Work access when a core membership ends.

``core`` emits ``membership_left`` inside the offboarding transaction. This
subscriber revokes the tenant grant and terminalizes the leaver's queued work
in the same transaction: if revocation fails, the departure rolls back rather
than leaving the person with access.

The grant is per ``(organization, user)`` while memberships are per department,
so a departure only closes Work when no other active membership remains in the
organization. ``post_delete`` covers rows removed by purge or any legacy DELETE
path that predates the write-path lockdown.
"""

import logging

from django.db import transaction
from django.utils import timezone

from core.models import Membership, MembershipStatusChoices
from core.signals import membership_left

from . import audit, runs
from .models import WorkAccessAudit, WorkMemberGrant, WorkReview, WorkRun

logger = logging.getLogger(__name__)

ACTIVE = ("queued", "running")


def _still_a_member(organization_id, user_id):
    return Membership.objects.filter(
        organization_id=organization_id,
        user_id=user_id,
        status=MembershipStatusChoices.ACTIVE,
    ).exists()


def revoke_grant(organization_id, user_id, *, reason, actor=None, before=None):
    """Revoke one grant in place. Returns True only on the first revocation."""
    grant = (
        WorkMemberGrant.objects.select_for_update()
        .filter(organization_id=organization_id, user_id=user_id)
        .first()
    )
    if grant is None or grant.revoked_at is not None:
        return False
    before = before if before is not None else audit.snapshot(grant)
    grant.enabled = False
    grant.revoked_at = timezone.now()
    grant.revoked_reason = reason
    grant.revoked_by = actor if getattr(actor, "is_authenticated", False) else None
    grant.save(update_fields=["enabled", "revoked_at", "revoked_reason", "revoked_by"])
    audit.record_access_event(
        action=WorkAccessAudit.Action.GRANT_REVOKED,
        organization=grant.organization,
        actor=grant.revoked_by,
        target_type="grant",
        target_id=grant.pk,
        before=before,
        after=audit.snapshot(grant),
    )
    return True


def close_member_access(organization_id, user_id, *, reason, actor=None):
    """Revoke the grant (if any) and stop active runs/reviews for one member."""
    if _still_a_member(organization_id, user_id):
        return {"grant_revoked": False, "runs_closed": 0, "reviews_closed": 0}

    now = timezone.now()
    revoked = revoke_grant(organization_id, user_id, reason=reason, actor=actor)

    run_count = 0
    for run in WorkRun.objects.select_for_update().filter(
        task__owner_id=user_id,
        task__organization_id=organization_id,
        status__in=ACTIVE,
    ):
        runs.terminal(run, "access_revoked", "member_disabled")
        run_count += 1

    review_count = 0
    for review in WorkReview.objects.select_for_update().filter(
        source_run__task__owner_id=user_id,
        source_run__task__organization_id=organization_id,
        status__in=ACTIVE,
    ):
        runs.terminal(review, "access_revoked", "member_disabled")
        review_count += 1

    if revoked or run_count or review_count:
        logger.info(
            "work.member.closed organization=%s user=%s reason=%s grant=%s runs=%s reviews=%s",
            organization_id,
            user_id,
            reason,
            revoked,
            run_count,
            review_count,
        )
    return {
        "grant_revoked": revoked,
        "runs_closed": run_count,
        "reviews_closed": review_count,
        "at": now,
    }


@transaction.atomic
def on_membership_left(  # noqa: PLR0913 - the signal sends this full contract
    sender,
    membership,
    actor=None,
    reason="",
    left_at=None,
    initiated_by="console",
    **kwargs,
):
    """Synchronous receiver: any failure propagates and rolls offboarding back."""
    return close_member_access(
        membership.organization_id,
        membership.user_id,
        reason=WorkMemberGrant.RevokedReason.MEMBERSHIP_LEFT,
        actor=actor,
    )


@transaction.atomic
def on_membership_deleted(sender, instance, **kwargs):
    """Fallback for purge and any pre-lockdown DELETE path."""
    return close_member_access(
        instance.organization_id,
        instance.user_id,
        reason=WorkMemberGrant.RevokedReason.MEMBERSHIP_LEFT,
    )


def connect():
    membership_left.connect(
        on_membership_left,
        sender=Membership,
        dispatch_uid="work.lifecycle.on_membership_left",
        weak=False,
    )
