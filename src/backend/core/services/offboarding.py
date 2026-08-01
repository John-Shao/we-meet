"""Member offboarding / rehire (P10 M1).

The heavy lifting is already done by the existing querysets: the directory
(``core/api/directory.py``), ``User.get_teams()`` and ``get_caller_organization``
all filter on ``status=ACTIVE``. Flipping a membership to ``LEFT`` therefore
makes the person vanish from the directory, drops their department-based
resource access and empties every org-scoped API for them — with no changes to
any of those call sites.

What this module adds is the bookkeeping those querysets cannot do on their own:
freezing the org facts for the "已离职" list, refusing to strand the
organization without an owner, reporting what the leaver still owns, and
severing the login.
"""

import logging

from django.db import transaction
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rest_framework import serializers

from core import models
from core.services.audit import record_audit

logger = logging.getLogger(__name__)

ACTIVE = models.MembershipStatusChoices.ACTIVE
LEFT = models.MembershipStatusChoices.LEFT


class OffboardError(serializers.ValidationError):
    """Raised for guard violations so DRF renders a 400 with the message."""


def _member_label(membership) -> str:
    user = membership.user
    return user.full_name or user.email or str(user.sub or user.id)


def assert_can_offboard(membership, actor) -> None:
    """Guards that must hold before a member may be offboarded.

    Mirrors the invariants ``MembershipAdminSerializer.validate`` already
    enforces for suspension — offboarding is a stronger form of the same thing
    and must not be a way around them.
    """
    if membership.user_id == actor.id:
        raise OffboardError({"detail": _("You cannot offboard yourself.")})

    if membership.status == LEFT:
        raise OffboardError({"detail": _("This member has already left.")})

    if (
        membership.status == ACTIVE
        and membership.org_role == models.OrgRoleChoices.OWNER
        and not models.Membership.objects.filter(
            organization_id=membership.organization_id,
            status=ACTIVE,
            org_role=models.OrgRoleChoices.OWNER,
        )
        .exclude(id=membership.id)
        .exists()
    ):
        raise OffboardError(
            {"detail": _("The organization must keep at least one active owner.")}
        )


def collect_owned_resources(membership) -> dict:
    """What this member would leave behind — shown before confirming offboard.

    Counts only, not the rows themselves: this drives a "3 items need a new
    owner" warning in the console, and the admin picks a recipient from there.
    """
    user = membership.user

    headed = models.Department.objects.filter(
        organization_id=membership.organization_id,
        head=user,
        deleted_at__isnull=True,
    )
    reports = models.Membership.objects.filter(manager=membership, status=ACTIVE)

    # Recordings are the only resource carrying team-based access today, so an
    # owner-role access row is genuinely the last handle on them.
    sole_owned_recordings = models.RecordingAccess.objects.filter(
        user=user, role=models.RoleChoices.OWNER
    ).count()
    owned_rooms = models.ResourceAccess.objects.filter(
        user=user, role=models.RoleChoices.OWNER
    ).count()

    return {
        "headed_departments": [
            {"id": str(d.id), "name": d.name} for d in headed
        ],
        "direct_reports_count": reports.count(),
        "owned_rooms": owned_rooms,
        "owned_recordings": sole_owned_recordings,
    }


@transaction.atomic
def offboard_membership(
    membership,
    *,
    actor,
    left_at=None,
    reason: str = "",
    transfer_head_to=None,
    allow_orphan_head: bool = False,
    disable_login: bool = True,
) -> dict:
    """Mark a membership as ``LEFT`` and settle what it leaves behind.

    Returns a small report the console shows after the fact (what was
    reassigned, what was orphaned).
    """
    assert_can_offboard(membership, actor)

    organization = membership.organization
    label = _member_label(membership)
    user = membership.user

    headed = list(
        models.Department.objects.filter(
            organization=organization, head=user, deleted_at__isnull=True
        )
    )
    if headed and transfer_head_to is None and not allow_orphan_head:
        raise OffboardError(
            {
                "transfer_head_to": _(
                    "This member heads %(count)d department(s). Choose a "
                    "replacement head or pass allow_orphan_head."
                )
                % {"count": len(headed)}
            }
        )
    if transfer_head_to is not None and transfer_head_to.organization_id != (
        organization.id
    ):
        raise OffboardError(
            {"transfer_head_to": _("The new head must be in the same organization.")}
        )

    # Freeze first — the fields it reads are about to stop being true.
    snapshot = membership.build_left_snapshot()

    new_head_user = transfer_head_to.user if transfer_head_to else None
    if headed:
        models.Department.objects.filter(
            id__in=[d.id for d in headed]
        ).update(head=new_head_user)

    # Detach reports so nobody keeps a leaver as their manager, which would
    # also break approval routing.
    reports_cleared = models.Membership.objects.filter(manager=membership).update(
        manager=None
    )
    models.Membership.objects.filter(dotted_manager=membership).update(
        dotted_manager=None
    )

    membership.status = LEFT
    membership.left_at = left_at or timezone.now()
    membership.left_reason = reason
    membership.left_snapshot = snapshot
    # Must clear: the partial unique constraint on (user, organization) where
    # is_primary would otherwise block this person being rehired later.
    membership.is_primary = False
    membership.save()

    owned = collect_owned_resources(membership)

    record_audit(
        actor=actor,
        organization=organization,
        action=models.AuditActionChoices.MEMBER_OFFBOARD,
        target_type="membership",
        target_id=membership.id,
        target_label=label,
        metadata={
            "left_at": membership.left_at.isoformat(),
            "reason": reason,
            "snapshot": snapshot,
            "headed_departments_transferred": [str(d.id) for d in headed],
            "new_head": str(new_head_user.id) if new_head_user else None,
            "reports_cleared": reports_cleared,
            "orphan_resources": {
                "rooms": owned["owned_rooms"],
                "recordings": owned["owned_recordings"],
            },
        },
    )

    if disable_login:
        # Best-effort and deliberately after commit: a Keycloak hiccup must not
        # roll back the offboarding. Failure is visible via the audit log and
        # the console's "login not disabled" flag.
        transaction.on_commit(
            lambda: _schedule_login_disable(user, organization, actor)
        )

    return {
        "reports_cleared": reports_cleared,
        "headed_departments_transferred": len(headed),
        "orphan_rooms": owned["owned_rooms"],
        "orphan_recordings": owned["owned_recordings"],
    }


def _schedule_login_disable(user, organization, actor):
    """Kick the Keycloak disable task, swallowing dispatch errors."""
    # Imported here so importing this module never drags in Celery wiring.
    from core.tasks.offboarding import (  # pylint: disable=import-outside-toplevel
        disable_keycloak_login,
    )

    if not user.sub:
        return
    try:
        disable_keycloak_login.delay(
            str(user.id), str(organization.id), str(actor.id) if actor else None
        )
    except Exception:  # pragma: no cover - dispatch failure must not surface
        logger.exception("Failed to schedule Keycloak disable for user %s", user.id)


@transaction.atomic
def rehire_membership(membership, *, actor, department=None, org_role=None) -> None:
    """Bring a departed member back on the same row.

    Reusing the row rather than creating one is what keeps
    ``unique(user, department)`` from blowing up when someone returns to the
    department they left.
    """
    if membership.status != LEFT:
        raise OffboardError({"detail": _("This member has not left.")})

    organization = membership.organization
    label = _member_label(membership)
    previous = {
        "left_at": membership.left_at.isoformat() if membership.left_at else None,
        "left_reason": membership.left_reason,
    }

    if department is not None:
        if department.organization_id != organization.id:
            raise OffboardError(
                {"department": _("The department must be in the same organization.")}
            )
        membership.department = department
    if org_role is not None:
        membership.org_role = org_role

    membership.status = ACTIVE
    membership.left_at = None
    membership.left_reason = ""
    membership.left_snapshot = {}
    # Restore primary only if the user has no other primary membership here.
    membership.is_primary = not (
        models.Membership.objects.filter(
            user=membership.user, organization=organization, is_primary=True
        )
        .exclude(id=membership.id)
        .exists()
    )
    membership.save()

    record_audit(
        actor=actor,
        organization=organization,
        action=models.AuditActionChoices.MEMBER_REHIRE,
        target_type="membership",
        target_id=membership.id,
        target_label=label,
        metadata={"previous": previous},
    )

    if membership.user.sub:
        from core.tasks.offboarding import (  # pylint: disable=import-outside-toplevel
            enable_keycloak_login,
        )

        transaction.on_commit(
            lambda: enable_keycloak_login.delay(str(membership.user_id))
        )
