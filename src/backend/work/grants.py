"""Seat-limited grant writes (P0-3).

Every grant mutation goes through this module: Django admin, the future
customer API and tests all share one admission decision. The entitlement row
is locked while a seat is claimed, so two concurrent grants cannot both take
the last seat.

Seats count distinct natural persons with a currently valid grant; expired and
revoked grants do not hold a seat, so no scheduled job has to release them.
"""

import logging

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework.exceptions import APIException

from core.models import Membership, MembershipStatusChoices, Organization

from . import audit
from .models import WorkAccessAudit, WorkMemberGrant, WorkOrganizationEntitlement

logger = logging.getLogger(__name__)


class MemberLimitReached(APIException):
    status_code = 409
    default_code = "member_limit_reached"

    def __init__(self, limit, active):
        super().__init__(
            detail={
                "code": self.default_code,
                "detail": "This organization has no Work seats left.",
                "meta": {"limit": limit, "active": active},
            },
            code=self.default_code,
        )
        # DRF turns every leaf into an ErrorDetail string, which would turn the
        # documented numeric ``meta`` into "2". Keep the wire shape literal.
        self.detail = {
            "code": self.default_code,
            "detail": "This organization has no Work seats left.",
            "meta": {"limit": limit, "active": active},
        }


class GrantConflict(APIException):
    status_code = 409
    default_detail = {
        "code": "grant_conflict",
        "detail": "This member's grant was changed concurrently; retry.",
    }
    default_code = "grant_conflict"


class GrantRejected(APIException):
    status_code = 409
    default_code = "grant_rejected"

    def __init__(self, code, detail):
        super().__init__(detail={"code": code, "detail": detail}, code=code)


def valid_grants(organization_id):
    now = timezone.now()
    return WorkMemberGrant.objects.filter(
        organization_id=organization_id,
        enabled=True,
        revoked_at__isnull=True,
    ).filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))


def active_seats(organization_id):
    """Distinct valid natural persons — not grant rows."""
    return valid_grants(organization_id).values("user_id").distinct().count()


def seat_usage(organization_id):
    limit = (
        WorkOrganizationEntitlement.objects.filter(
            organization_id=organization_id
        )
        .values_list("member_limit", flat=True)
        .first()
    )
    return {"active": active_seats(organization_id), "limit": limit}


def _lock_entitlement(organization_id):
    entitlement = (
        WorkOrganizationEntitlement.objects.select_for_update()
        .filter(organization_id=organization_id)
        .first()
    )
    if entitlement is None or not entitlement.enabled:
        raise GrantRejected("org_disabled", "Work is not enabled for this tenant.")
    return entitlement


def _require_active_member(organization_id, user_id):
    if not Organization.objects.filter(pk=organization_id, is_active=True).exists():
        raise GrantRejected("org_disabled", "This organization is not active.")
    if not Membership.objects.filter(
        organization_id=organization_id,
        user_id=user_id,
        status=MembershipStatusChoices.ACTIVE,
    ).exists():
        raise GrantRejected(
            "member_not_active", "Only active members can hold a Work seat."
        )


def _claim_seat(entitlement, grant):
    """Raise unless this write keeps the tenant within its seat limit."""
    limit = entitlement.member_limit
    if limit is None:
        return
    if grant is not None and grant.is_active():
        return
    active = active_seats(entitlement.organization_id)
    if active >= limit:
        raise MemberLimitReached(limit, active)


def _audit(action, grant, before, request_id=""):
    audit.record_access_event(
        action=action,
        organization=grant.organization,
        actor=grant.granted_by,
        target_type="grant",
        target_id=grant.pk,
        request_id=request_id,
        before=before,
        after=audit.snapshot(grant),
    )


@transaction.atomic
def grant_member(  # noqa: PLR0913 -- explicit write contract
    *,
    organization_id,
    user_id,
    actor=None,
    source=WorkMemberGrant.Source.CUSTOMER,
    expires_at=None,
    request_id="",
):
    """Grant or re-enable Work access, claiming a seat when needed."""
    entitlement = _lock_entitlement(organization_id)
    _require_active_member(organization_id, user_id)

    grant = (
        WorkMemberGrant.objects.select_for_update()
        .filter(organization_id=organization_id, user_id=user_id)
        .first()
    )
    before = audit.snapshot(grant)
    if grant is None:
        _claim_seat(entitlement, None)
        grant = WorkMemberGrant(
            organization_id=organization_id,
            user_id=user_id,
            enabled=True,
            source=source,
            granted_by=actor if getattr(actor, "is_authenticated", False) else None,
            expires_at=expires_at,
        )
        action = WorkAccessAudit.Action.GRANT_CREATED
    else:
        _claim_seat(entitlement, grant)
        action = (
            WorkAccessAudit.Action.GRANT_RESTORED
            if grant.revoked_at is not None
            else WorkAccessAudit.Action.GRANT_UPDATED
        )
        grant.enabled = True
        grant.revoked_at = None
        grant.revoked_reason = ""
        grant.revoked_by = None
        grant.source = source
        grant.granted_by = actor if getattr(actor, "is_authenticated", False) else None
        grant.expires_at = expires_at

    try:
        with transaction.atomic():
            grant.save()
    except IntegrityError as exc:
        raise GrantConflict() from exc

    _audit(action, grant, before, request_id)
    return grant


@transaction.atomic
def disable_member_grant(
    *, organization_id, user_id, actor=None, request_id=""
):
    """Switch a grant off without recording a lifecycle revocation."""
    grant = (
        WorkMemberGrant.objects.select_for_update()
        .filter(organization_id=organization_id, user_id=user_id)
        .first()
    )
    if grant is None:
        raise GrantRejected("grant_not_found", "This member has no Work grant.")
    if not grant.enabled:
        return grant
    before = audit.snapshot(grant)
    grant.enabled = False
    grant.save(update_fields=["enabled"])
    _audit(WorkAccessAudit.Action.GRANT_UPDATED, grant, before, request_id)
    return grant


@transaction.atomic
def revoke_member_grant(  # noqa: PLR0913 -- explicit write contract
    *,
    organization_id,
    user_id,
    actor=None,
    reason=WorkMemberGrant.RevokedReason.MANUAL,
    request_id="",
):
    """Soft-revoke a grant. Repeating the call keeps the first revocation."""
    grant = (
        WorkMemberGrant.objects.select_for_update()
        .filter(organization_id=organization_id, user_id=user_id)
        .first()
    )
    if grant is None:
        raise GrantRejected("grant_not_found", "This member has no Work grant.")
    if grant.revoked_at is not None:
        return grant
    before = audit.snapshot(grant)
    grant.enabled = False
    grant.revoked_at = timezone.now()
    grant.revoked_reason = reason
    grant.revoked_by = actor if getattr(actor, "is_authenticated", False) else None
    grant.save(
        update_fields=["enabled", "revoked_at", "revoked_reason", "revoked_by"]
    )
    _audit(WorkAccessAudit.Action.GRANT_REVOKED, grant, before, request_id)
    return grant


@transaction.atomic
def restore_member_grant(  # noqa: PLR0913 -- explicit write contract
    *, organization_id, user_id, actor=None, expires_at=None, request_id=""
):
    """Bring a revoked grant back, re-checking the seat limit."""
    entitlement = _lock_entitlement(organization_id)
    _require_active_member(organization_id, user_id)
    grant = (
        WorkMemberGrant.objects.select_for_update()
        .filter(organization_id=organization_id, user_id=user_id)
        .first()
    )
    if grant is None:
        raise GrantRejected("grant_not_found", "This member has no Work grant.")
    if grant.revoked_at is None and grant.enabled:
        return grant
    _claim_seat(entitlement, grant)
    before = audit.snapshot(grant)
    grant.enabled = True
    grant.revoked_at = None
    grant.revoked_reason = ""
    grant.revoked_by = None
    if expires_at is not None:
        grant.expires_at = expires_at
    grant.save(
        update_fields=[
            "enabled",
            "revoked_at",
            "revoked_reason",
            "revoked_by",
            "expires_at",
        ]
    )
    _audit(WorkAccessAudit.Action.GRANT_RESTORED, grant, before, request_id)
    return grant
