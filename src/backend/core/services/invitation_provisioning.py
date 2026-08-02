"""Claim pending organization invitations on first login (M 端 pre-provisioning).

When an invitee signs in, the OIDC claim hook calls ``claim_pending_invitations``
so their Membership is created with the invited department / role / title rather
than the plain org-level default. Kept separate from the auth backend so it is
unit-testable without an OIDC round-trip.

**This runs exactly once per invitation, on the login that redeems it.** If the
match fails there, ``ensure_default_org_membership`` immediately gives the
person a plain membership, and every later login then sees ``already_member``
and skips the invitation forever. A missed match is therefore not "retried next
time" — it is permanent, and it looks like nothing happened. That is why the
caller resolves the phone number *before* calling this (P10 M2-g).
"""

from django.db.models import Q
from django.utils import timezone

from core.models import (
    InvitationStatusChoices,
    Membership,
    MembershipStatusChoices,
    OrgInvitation,
)
from core.services.phone import normalize_cn_phone


def claim_pending_invitations(user, *, phone=None):
    """Apply every pending invitation matching this user's email or phone.

    For each match, create the user's Membership with the invited department /
    role / title — only if they have no membership in that organization yet
    (existing memberships are left untouched) — and mark the invitation
    accepted. Returns the number of invitations consumed.

    ``phone`` overrides ``user.phone`` and is how the authentication backend
    passes a number it learned from the OIDC claims. Email matching is
    case-insensitive; a user with neither key matches nothing.

    The invitation's ``full_name`` is deliberately *not* copied onto the User:
    ``full_name`` is recomputed from the OIDC claims on every sign-in, so it
    would be reverted at the next login and the console would look like it lost
    the value it had just shown.
    """
    email = (user.email or "").strip()
    number = normalize_cn_phone(phone or getattr(user, "phone", ""))
    if not email and not number:
        return 0

    match = Q()
    if email:
        match |= Q(email__iexact=email)
    if number:
        match |= Q(phone=number)

    invitations = OrgInvitation.objects.filter(
        match, status=InvitationStatusChoices.PENDING
    ).select_related("organization", "department")

    applied = 0
    for invitation in invitations:
        already_member = Membership.objects.filter(
            user=user, organization=invitation.organization
        ).exists()
        if not already_member:
            Membership.objects.create(
                organization=invitation.organization,
                user=user,
                department=invitation.department,
                org_role=invitation.org_role,
                title=invitation.title,
                is_primary=True,
                status=MembershipStatusChoices.ACTIVE,
            )
        invitation.status = InvitationStatusChoices.ACCEPTED
        invitation.accepted_user = user
        invitation.accepted_at = timezone.now()
        invitation.save(
            update_fields=["status", "accepted_user", "accepted_at", "updated_at"]
        )
        applied += 1
    return applied
