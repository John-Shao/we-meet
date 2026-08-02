"""Invite links and the applications they produce (P10 M4).

Three operations with one rule between them: **the link is re-read at approval
time, never trusted from the application.** A link can be revoked, re-dated or
used up in the minutes between somebody applying and an administrator getting
to the queue, and the whole point of an expiry is that it is checked when it
matters.

⚠️ What approval means today: every authenticated user is already auto-joined to
the default organization (``authentication/backends.py``), so approving decides
their **department and role**, not whether they get in. See
`docs/phases/p10b-invitation-system.md` §三 — this is a known property of the
current admission model, not something M4 introduced.
"""

import random

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from core import models
from core.services.audit import record_audit
from core.services.phone import normalize_cn_phone

#: Probability of running the sweep on any given application. The project has
#: no celery beat, so cleanup rides on write paths — same shape as
#: ``core/services/activity.py::purge_old_activity``.
SWEEP_PROBABILITY = 0.001


class InviteError(Exception):
    """Raised for guard violations so the API layer renders a 400/409."""

    def __init__(self, message, code="invalid"):
        super().__init__(message)
        self.message = message
        self.code = code


def resolve_usable_link(code):
    """The link for ``code``, or ``None`` if it cannot take applications.

    **One return value for every kind of failure** — wrong code, expired,
    revoked, used up, dead organization. Callers must not report which:
    telling somebody "that code exists but expired" is an oracle that turns
    guessing into enumeration.
    """
    if not code:
        return None
    link = (
        models.OrgInviteLink.objects.filter(code=code.strip().upper())
        .select_related("organization", "department")
        .first()
    )
    if link is None or not link.is_usable():
        return None
    return link


def _existing_membership(organization, user):
    """Any membership this user has in the organization — including departed."""
    return (
        models.Membership.objects.filter(organization=organization, user=user)
        .order_by("-is_primary", "status")
        .first()
    )


def apply_to_link(link, user):
    """File an application (or join outright when the link needs no approval).

    Returns the ``OrgJoinRequest``. Its status is ``approved`` when the link is
    open, ``pending`` otherwise.
    """
    if random.random() < SWEEP_PROBABILITY:  # noqa: S311 — not cryptographic
        expire_stale_requests()

    membership = _existing_membership(link.organization, user)
    if (
        membership is not None
        and membership.status == models.MembershipStatusChoices.ACTIVE
        and membership.department_id == link.department_id
        and membership.org_role == link.org_role
    ):
        # Nothing to decide: they are already exactly where the link would put
        # them. Filing an application the reviewer can only rubber-stamp is
        # worse than saying so.
        raise InviteError(
            _("You are already a member of this organization."), code="already_member"
        )

    pending = models.OrgJoinRequest.objects.filter(
        organization=link.organization,
        user=user,
        status=models.OrgJoinStatusChoices.PENDING,
    ).first()
    if pending is not None:
        return pending

    request = models.OrgJoinRequest.objects.create(
        organization=link.organization,
        link=link,
        user=user,
        # Snapshots — the reviewer reads who applied, not who they became.
        phone=normalize_cn_phone(user.phone) or (user.phone or "")[:32],
        full_name=user.full_name or user.short_name or "",
        department=link.department,
        org_role=link.org_role,
        status=models.OrgJoinStatusChoices.PENDING,
    )
    if not link.require_approval:
        _place(request, actor=None)
    return request


@transaction.atomic
def approve_request(request, *, actor, department=None, org_role=None):
    """Approve an application and place the person.

    ``department`` / ``org_role`` override what the link proposed — a reviewer
    who has to accept the applicant's word for it verbatim will approve wrong
    things rather than reject them.
    """
    if request.status != models.OrgJoinStatusChoices.PENDING:
        raise InviteError(_("This application has already been handled."))

    # Re-read the link rather than trusting the application: it may have been
    # revoked, re-dated or used up while this row sat in the queue.
    if request.link_id is not None:
        link = models.OrgInviteLink.objects.select_for_update().get(pk=request.link_id)
        if not link.is_usable():
            raise InviteError(
                _("The invite link is no longer valid. Revoke or re-issue it.")
            )

    if department is not None:
        request.department = department
    if org_role:
        request.org_role = org_role

    _place(request, actor=actor)

    record_audit(
        actor=actor,
        organization=request.organization,
        action=models.AuditActionChoices.JOIN_REQUEST_APPROVE,
        target_type="join_request",
        target_id=request.id,
        target_label=request.full_name or request.phone,
        metadata={
            "department": str(request.department_id) if request.department_id else None,
            "org_role": request.org_role,
            "link": request.link.code if request.link_id else None,
        },
    )
    return request


def _place(request, *, actor):
    """Materialize the placement and mark the application approved.

    The interesting branch is the middle one. Because of auto-join, an
    applicant **usually already has a membership**, so creating one here would
    not raise — ``Membership`` has ``unique(user, department)`` and
    ``unique(user, organization) where is_primary``, not ``unique(user,
    organization)``. A second row with a different department slips straight
    through and the person quietly appears twice in the directory. Updating is
    not an optimization; it is the only correct branch.
    """
    membership = _existing_membership(request.organization, request.user)

    if membership is None:
        models.Membership.objects.create(
            organization=request.organization,
            user=request.user,
            department=request.department,
            org_role=request.org_role,
            is_primary=True,
            status=models.MembershipStatusChoices.ACTIVE,
        )
    elif membership.status == models.MembershipStatusChoices.LEFT:
        # They were here before. Rehire rather than leave them departed with a
        # new department — offboarding froze things that need unfreezing.
        from core.services import offboarding

        offboarding.rehire_membership(
            membership,
            actor=actor,
            department=request.department,
            org_role=request.org_role,
        )
    else:
        # Active or suspended. Placement changes; **status does not** — a
        # suspension is an administrator's decision and approving a join
        # request is not the place to quietly undo it.
        membership.department = request.department
        membership.org_role = request.org_role
        membership.save(update_fields=["department", "org_role", "updated_at"])

    request.status = models.OrgJoinStatusChoices.APPROVED
    request.reviewed_by = actor
    request.reviewed_at = timezone.now()
    request.save(
        update_fields=[
            "status",
            "reviewed_by",
            "reviewed_at",
            "department",
            "org_role",
            "updated_at",
        ]
    )

    if request.link_id is not None:
        # Counted on approval, not on application: a handful of rejected
        # applicants must not exhaust a link's quota.
        models.OrgInviteLink.objects.filter(pk=request.link_id).update(
            used_count=F("used_count") + 1
        )


def reject_request(request, *, actor, reason=""):
    if request.status != models.OrgJoinStatusChoices.PENDING:
        raise InviteError(_("This application has already been handled."))

    request.status = models.OrgJoinStatusChoices.REJECTED
    request.reviewed_by = actor
    request.reviewed_at = timezone.now()
    request.reject_reason = (reason or "")[:255]
    request.save(
        update_fields=[
            "status",
            "reviewed_by",
            "reviewed_at",
            "reject_reason",
            "updated_at",
        ]
    )
    record_audit(
        actor=actor,
        organization=request.organization,
        action=models.AuditActionChoices.JOIN_REQUEST_REJECT,
        target_type="join_request",
        target_id=request.id,
        target_label=request.full_name or request.phone,
        metadata={"reason": request.reject_reason},
    )
    return request


def expire_stale_requests():
    """Retire applications whose link has died under them.

    Without this a revoked link leaves its applications pending forever, and
    the queue badge becomes a number nobody can clear.
    """
    now = timezone.now()
    dead_links = models.OrgInviteLink.objects.filter(
        Q(is_active=False) | Q(expires_at__lte=now)
    ).values_list("pk", flat=True)
    return models.OrgJoinRequest.objects.filter(
        status=models.OrgJoinStatusChoices.PENDING, link_id__in=list(dead_links)
    ).update(status=models.OrgJoinStatusChoices.EXPIRED, updated_at=now)
