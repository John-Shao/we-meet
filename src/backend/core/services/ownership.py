"""Ownership transfer: the caller hands their OWNER role to another member.

The caller becomes ``administrator``; no other owner is touched. This is the
only path that both grants and demotes an owner in one operation, so it is also
the only place that can move the last owner without tripping the "at least one
active owner" guard — the target receives it in the same transaction.
"""

from django.db import transaction

from rest_framework import status
from rest_framework.exceptions import APIException

from core import models
from core.services import membership as membership_service
from core.services.audit import record_audit

ACTIVE = models.MembershipStatusChoices.ACTIVE
OWNER = models.OrgRoleChoices.OWNER
ADMIN = models.OrgRoleChoices.ADMIN


class OwnershipError(APIException):
    """A stable, machine-readable transfer failure."""

    def __init__(self, code, detail, status_code=status.HTTP_400_BAD_REQUEST):
        self.status_code = status_code
        self.code = code
        super().__init__(detail={"code": code, "detail": str(detail)})


def _locked_membership(membership_id):
    return models.Membership.objects.select_for_update().filter(id=membership_id).first()


def transfer_ownership(*, actor_membership, target_membership):
    """Transfer the actor's owner role to ``target_membership``.

    Lock order matches every other member write: organization row first, then
    the two membership rows in id order.
    """
    if target_membership.organization_id != actor_membership.organization_id:
        raise OwnershipError(
            "target_not_found",
            "That member is not in your organization.",
            status.HTTP_404_NOT_FOUND,
        )
    if target_membership.id == actor_membership.id:
        raise OwnershipError("target_is_self", "You already own this organization.")

    with transaction.atomic():
        membership_service.lock_organization(actor_membership.organization_id)
        first_id, second_id = sorted([actor_membership.id, target_membership.id])
        first = _locked_membership(first_id)
        second = _locked_membership(second_id)
        rows = {row.id: row for row in (first, second) if row is not None}
        actor = rows.get(actor_membership.id)
        target = rows.get(target_membership.id)
        if actor is None or target is None:
            raise OwnershipError(
                "ownership_changed",
                "The organization ownership changed. Reload and try again.",
                status.HTTP_409_CONFLICT,
            )

        if actor.status != ACTIVE or actor.org_role != OWNER:
            raise OwnershipError(
                "not_organization_owner",
                "Only an active owner can transfer ownership.",
                status.HTTP_403_FORBIDDEN,
            )
        if target.status != ACTIVE:
            raise OwnershipError(
                "target_not_active", "The target member is not active."
            )
        if target.org_role == OWNER:
            raise OwnershipError(
                "target_already_owner", "The target member is already an owner."
            )

        previous_target_role = target.org_role
        actor.org_role = ADMIN
        target.org_role = OWNER
        actor.save(update_fields=["org_role", "updated_at"])
        target.save(update_fields=["org_role", "updated_at"])

        record_audit(
            actor=actor.user,
            organization=target.organization,
            action=models.AuditActionChoices.MEMBER_OWNER_TRANSFERRED,
            target_type="membership",
            target_id=target.id,
            target_label=target.user.full_name or target.user.email or "",
            metadata={
                "actor_membership_id": str(actor.id),
                "target_membership_id": str(target.id),
                "actor_user_id": str(actor.user_id),
                "target_user_id": str(target.user_id),
                "from": {"actor": OWNER, "target": previous_target_role},
                "to": {"actor": ADMIN, "target": OWNER},
            },
        )
        return actor, target
