"""Claim pending organization invitations on first login (M 端 pre-provisioning).

When an invitee signs in, the OIDC claim hook calls ``claim_pending_invitations``
so their Membership is created with the invited department / role / title rather
than the plain org-level default. Kept separate from the auth backend so it is
unit-testable without an OIDC round-trip.
"""

from django.utils import timezone

from core.models import (
    InvitationStatusChoices,
    Membership,
    MembershipStatusChoices,
    OrgInvitation,
)


def claim_pending_invitations(user):
    """Apply every pending invitation matching ``user.email``.

    For each match, create the user's Membership with the invited department /
    role / title — only if they have no membership in that organization yet
    (existing memberships are left untouched) — and mark the invitation
    accepted. Returns the number of invitations consumed. Case-insensitive on
    email; users without an email match nothing.
    """
    if not user.email:
        return 0

    invitations = OrgInvitation.objects.filter(
        email__iexact=user.email, status=InvitationStatusChoices.PENDING
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
