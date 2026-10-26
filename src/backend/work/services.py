"""Shared tenant scope and stable Work error codes."""

from core.models import Membership, MembershipStatusChoices

from . import access

MAX_ARTIFACT_CHARS = 40_000


class WorkError(ValueError):
    """Stable public error code, never provider payloads or internals."""

    def __init__(self, code, status=400):
        self.code = code
        self.status = status
        super().__init__(code)


def organization_for(user):
    """Match primary-first directory scope without depending on meeting services."""
    return (
        Membership.objects.filter(
            user=user,
            status=MembershipStatusChoices.ACTIVE,
            organization__is_active=True,
        )
        .order_by("-is_primary", "created_at")
        .values_list("organization_id", flat=True)
        .first()
    )


def scoped_organization(user, organization_id=None):
    """Explicit request organization, else the legacy single-org fallback."""
    return organization_id if organization_id is not None else organization_for(user)


def require_organization(user, organization_id=None):
    """New tenant data must never be written without an organization."""
    organization_id = scoped_organization(user, organization_id)
    if organization_id is None and access.enabled():
        raise WorkError("organization_required", 409)
    return organization_id
