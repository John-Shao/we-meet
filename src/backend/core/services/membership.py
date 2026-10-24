"""Single write path for membership roles and lifecycle status (P0-1).

Every entry point that can change ``org_role`` or ``status`` — HTTP, Django
admin, CSV import, invite approval, rehire, ownership transfer — goes through
this module. Two invariants are enforced here rather than in each serializer:

* only an active owner may grant or demote an owner;
* the organization always keeps at least one active owner, and never has more
  than :data:`MAX_ACTIVE_OWNERS` at once.

Both are checked while holding the organization row lock, then the affected
membership rows in id order. That is the same lock order every lifecycle write
uses (organization → membership), so concurrent transfers and demotions cannot
deadlock or interleave into a zero-owner / two-hundred-owner state.
"""

import contextlib
import contextvars

from django.db import transaction
from django.db.models import Q
from django.utils.translation import gettext_lazy as _

from rest_framework import serializers

from core import models
from core.services.audit import record_audit

ACTIVE = models.MembershipStatusChoices.ACTIVE
SUSPENDED = models.MembershipStatusChoices.SUSPENDED
INVITED = models.MembershipStatusChoices.INVITED
LEFT = models.MembershipStatusChoices.LEFT
OWNER = models.OrgRoleChoices.OWNER
ADMIN = models.OrgRoleChoices.ADMIN

#: Hard cap on simultaneously active owners. One organization, one number —
#: adjust here and nowhere else.
MAX_ACTIVE_OWNERS = 3

#: Roles that any non-owner path (create / invite / import / rehire) may assign.
NON_OWNER_ROLES = frozenset(
    role for role in models.OrgRoleChoices.values if role != OWNER
)

WRITABLE_STATUSES = frozenset({ACTIVE, SUSPENDED, INVITED})

#: Set only while ``offboarding.offboard_membership`` saves the LEFT row. Model
#: validation rejects every other transition into LEFT, which covers Django
#: admin, management commands and any future non-HTTP caller.
_left_transition = contextvars.ContextVar("membership_left_transition", default=False)


@contextlib.contextmanager
def left_transition():
    token = _left_transition.set(True)
    try:
        yield
    finally:
        _left_transition.reset(token)


def left_transition_allowed():
    return _left_transition.get()


class MembershipWriteError(serializers.ValidationError):
    """A guard violation; DRF renders it as a 400 with a field error."""


def owner_only_error():
    return MembershipWriteError(
        {"org_role": _("Only an active owner can change ownership.")}
    )


def owner_limit_error():
    return MembershipWriteError(
        {
            "org_role": _(
                "An organization can have at most %(limit)d active owners."
            )
            % {"limit": MAX_ACTIVE_OWNERS}
        }
    )


def last_owner_error():
    return MembershipWriteError(
        {"detail": _("The organization must keep at least one active owner.")}
    )


def lock_organization(organization_id):
    """Lock the organization row — the serialization point for member writes."""
    return models.Organization.objects.select_for_update().get(id=organization_id)


def _lock_memberships(ids):
    """Lock membership rows in id order; the caller must hold the org lock."""
    rows = list(
        models.Membership.objects.select_for_update()
        .filter(id__in=set(ids))
        .order_by("id")
    )
    return {row.id: row for row in rows}


def active_owner_count(organization_id, *, exclude_id=None):
    queryset = models.Membership.objects.filter(
        organization_id=organization_id, status=ACTIVE, org_role=OWNER
    )
    if exclude_id is not None:
        queryset = queryset.exclude(id=exclude_id)
    return queryset.count()


def is_active_owner(membership):
    return bool(
        membership
        and membership.status == ACTIVE
        and membership.org_role == OWNER
    )


def _lock_with_actor(membership, actor):
    """Lock the target plus every membership of the actor in the same org.

    The actor may hold more than one membership row in an organization (one per
    department). Any of them being an active owner is enough; re-reading under
    the lock is what makes "am I still an owner?" trustworthy after a concurrent
    transfer. ``actor=None`` is a system write (invite auto-join): only the
    target is locked, and every ownership guard below still applies.
    """
    queryset = models.Membership.objects.filter(
        organization_id=membership.organization_id
    )
    queryset = (
        queryset.filter(Q(id=membership.id))
        if actor is None
        else queryset.filter(Q(user=actor) | Q(id=membership.id))
    )
    ids = list(queryset.values_list("id", flat=True))
    rows = _lock_memberships(ids)
    actor_rows = (
        []
        if actor is None
        else [row for row in rows.values() if row.user_id == actor.id]
    )
    target = rows.get(membership.id)
    return target, actor_rows


def _require_active_owner(actor_rows):
    if not any(is_active_owner(row) for row in actor_rows):
        raise owner_only_error()


def assert_can_grant_owner(organization_id, *, actor, target_id=None):
    """Owner-only + cap check; caller must already hold the organization lock."""
    if not models.Membership.objects.filter(
        organization_id=organization_id,
        user=actor,
        status=ACTIVE,
        org_role=OWNER,
    ).exists():
        raise owner_only_error()
    if active_owner_count(organization_id, exclude_id=target_id) >= (
        MAX_ACTIVE_OWNERS
    ):
        raise owner_limit_error()


def set_role(membership, *, actor, role):
    """Change ``org_role`` under the organization lock and write the audit row.

    Returns the freshly locked membership instance. Owner grants and demotions
    additionally require an active owner as the actor; a demotion is refused
    when it would leave the organization without an owner.
    """
    if role not in models.OrgRoleChoices.values:
        raise MembershipWriteError({"org_role": _("Unknown organization role.")})

    if role == membership.org_role:
        return membership

    with transaction.atomic():
        lock_organization(membership.organization_id)
        target, actor_rows = _lock_with_actor(membership, actor)
        if target is None:
            raise MembershipWriteError({"detail": _("Membership no longer exists.")})

        if target.org_role == role:
            return target

        previous = target.org_role
        touches_ownership = OWNER in (previous, role)
        if touches_ownership:
            _require_active_owner(actor_rows)

        if role == OWNER:
            if target.status != ACTIVE:
                raise MembershipWriteError(
                    {"org_role": _("Only an active member can become an owner.")}
                )
            if active_owner_count(
                target.organization_id, exclude_id=target.id
            ) >= MAX_ACTIVE_OWNERS:
                raise owner_limit_error()
        elif previous == OWNER:
            if not active_owner_count(
                target.organization_id, exclude_id=target.id
            ):
                raise last_owner_error()

        target.org_role = role
        target.save(update_fields=["org_role", "updated_at"])

        record_audit(
            actor=actor,
            organization=target.organization,
            action=models.AuditActionChoices.MEMBER_ROLE_CHANGE,
            target_type="membership",
            target_id=target.id,
            target_label=target.user.full_name or target.user.email or "",
            metadata={
                "from": previous,
                "to": role,
                "actor_membership_id": str(actor_rows[0].id) if actor_rows else None,
                "ownership_changed": touches_ownership,
            },
        )
        return target


def set_status(membership, *, actor, status):
    """Change lifecycle status through the supported transitions.

    ``left`` is refused outright: departure has side effects (head transfer,
    snapshots, Work revocation) that only ``offboarding.offboard_membership``
    performs. Returns the freshly locked membership instance.
    """
    if status == LEFT:
        raise MembershipWriteError(
            {"status": _("Use the offboard action to record a departure.")}
        )
    if status not in WRITABLE_STATUSES:
        raise MembershipWriteError({"status": _("Unsupported membership status.")})
    if status == membership.status:
        return membership

    with transaction.atomic():
        lock_organization(membership.organization_id)
        target, actor_rows = _lock_with_actor(membership, actor)
        if target is None:
            raise MembershipWriteError({"detail": _("Membership no longer exists.")})
        if target.status == status:
            return target

        was_active_owner = is_active_owner(target)
        if was_active_owner and status != ACTIVE:
            _require_active_owner(actor_rows)
            if not active_owner_count(
                target.organization_id, exclude_id=target.id
            ):
                raise last_owner_error()
        elif status == ACTIVE and target.org_role == OWNER:
            # Reactivating a suspended owner adds a seat back, so it needs the
            # same two checks as granting ownership — otherwise a suspend /
            # restore cycle walks past the cap.
            _require_active_owner(actor_rows)
            if active_owner_count(
                target.organization_id, exclude_id=target.id
            ) >= MAX_ACTIVE_OWNERS:
                raise owner_limit_error()

        previous = target.status
        target.status = status
        if status == SUSPENDED:
            action = models.AuditActionChoices.MEMBER_SUSPEND
        elif previous == SUSPENDED and status == ACTIVE:
            action = models.AuditActionChoices.MEMBER_RESTORE
        else:
            action = models.AuditActionChoices.MEMBER_UPDATE
        target.save(update_fields=["status", "updated_at"])

        record_audit(
            actor=actor,
            organization=target.organization,
            action=action,
            target_type="membership",
            target_id=target.id,
            target_label=target.user.full_name or target.user.email or "",
            metadata={
                "from": previous,
                "to": status,
                "ownership_changed": was_active_owner,
                "actor_membership_id": str(actor_rows[0].id) if actor_rows else None,
            },
        )
        return target
